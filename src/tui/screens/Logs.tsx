import { basename, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import { loadConfigFile } from "../../core/config/loadConfig";
import { formatBytes } from "../../core/inspect/collStats";
import {
	filterLines,
	listLogFiles,
	readSince,
	tailFile,
} from "../../core/logs/readLog";
import { tailCommand } from "../../core/logs/tailCommand";
import { levelOf } from "../../core/run/logLines";
import { detectBackends, preferredBackend } from "../../core/service/detect";
import { agentLabel } from "../../core/service/launchd";
import { type Backend, serviceName } from "../../core/service/types";
import {
	type Chip,
	layout,
	Panel,
	Shell,
	SIDEBAR_WIDTH,
	Stat,
} from "../components/Shell";
import { useProcess } from "../hooks/useProcess";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { glyph, theme } from "../theme";

/**
 * Duas leituras de log, lado a lado com a lista de fontes:
 *
 * - ARQUIVO (`./logs/*.log`): o histórico que o winston grava sempre, mesmo sem
 *   ninguém olhando. É onde se investiga o que aconteceu ontem às 3h.
 * - AO VIVO: o stdout do serviço rodando AGORA em background, pelo seguidor
 *   nativo do supervisor (journalctl/pm2/docker/tail).
 *
 * Uma não substitui a outra: o arquivo não tem o que o supervisor imprimiu
 * antes do logger inicializar, e o supervisor não guarda o histórico
 * rotacionado.
 */

const POLL_MS = 1000;

type Source =
	| { kind: "file"; path: string; name: string }
	| { kind: "live"; file: string };

export function LogsScreen({
	dir,
	file,
	onExit,
}: {
	dir: string;
	file?: string;
	onExit: () => void;
}) {
	const { columns, rows } = useTerminalSize();
	const l = layout(columns, rows);

	const files = listLogFiles(dir);
	const configs = detectConfigs(dir, { recursive: true }).filter(
		(c) => c.kind !== "desconhecido",
	);

	const sources: Source[] = [
		...files.map((f) => ({
			kind: "file" as const,
			path: f.path,
			name: f.name,
		})),
		...configs.map((c) => ({ kind: "live" as const, file: c.file })),
	];

	const [index, setIndex] = useState(() => {
		if (!file) return 0;
		const i = sources.findIndex((s) => s.kind === "live" && s.file === file);
		return i >= 0 ? i : 0;
	});
	const [pane, setPane] = useState<"sources" | "content">("content");

	const source = sources[Math.min(index, sources.length - 1)];

	useInput((_input, key) => {
		if (key.escape) {
			onExit();
			return;
		}
		if (key.tab) {
			setPane((p) => (p === "sources" ? "content" : "sources"));
			return;
		}
		if (pane !== "sources" || sources.length === 0) return;
		if (key.upArrow) setIndex((i) => (i === 0 ? sources.length - 1 : i - 1));
		if (key.downArrow) setIndex((i) => (i === sources.length - 1 ? 0 : i + 1));
	});

	return (
		<Shell
			chips={chipsFor(source, dir)}
			columns={columns}
			rows={rows}
			hints={[
				{ keys: "tab", label: "painel" },
				{ keys: "↑↓", label: pane === "sources" ? "fonte" : "rolar" },
				{ keys: "/", label: "buscar" },
				{ keys: "f", label: "seguir" },
				{ keys: "g", label: "fim" },
				{ keys: "esc", label: "voltar" },
			]}
		>
			<Panel
				title="fontes"
				width={SIDEBAR_WIDTH}
				height={l.body}
				focused={pane === "sources"}
			>
				<SourceList
					sources={sources}
					index={index}
					focused={pane === "sources"}
				/>
			</Panel>

			{!source ? (
				<Panel title="logs" width={l.center} height={l.body}>
					<Text color={theme.muted}>
						nenhum log em ./logs e nenhuma config nesta pasta
					</Text>
				</Panel>
			) : source.kind === "file" ? (
				<FileViewer
					key={source.path}
					path={source.path}
					width={l.center}
					aside={l.aside}
					height={l.body}
					visibleRows={l.panelRows - 1}
					focused={pane === "content"}
				/>
			) : (
				<LiveViewer
					key={source.file}
					dir={dir}
					file={source.file}
					width={l.center}
					aside={l.aside}
					height={l.body}
					visibleRows={l.panelRows - 1}
				/>
			)}
		</Shell>
	);
}

function SourceList({
	sources,
	index,
	focused,
}: {
	sources: Source[];
	index: number;
	focused: boolean;
}) {
	if (sources.length === 0)
		return <Text color={theme.muted}>nada para ler</Text>;

	let lastKind: string | null = null;

	return (
		<Box flexDirection="column">
			{sources.map((s, i) => {
				const active = i === index;
				const header = s.kind !== lastKind ? s.kind : null;
				lastKind = s.kind;
				const label = s.kind === "file" ? s.name : basename(s.file);

				return (
					<Box key={`${s.kind}:${label}`} flexDirection="column">
						{header ? (
							<Text color={theme.border}>
								{header === "file" ? "─ arquivo ─" : "─ ao vivo ─"}
							</Text>
						) : null}
						<Text
							color={
								active ? (focused ? theme.selection : theme.label) : theme.muted
							}
							bold={active}
							wrap="truncate-end"
						>
							{active ? "▍" : " "}
							{label}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

/**
 * Visualizador com "seguir" por polling de offset. `fs.watch` seria mais
 * elegante, mas é inconsistente entre plataformas e não dispara em arquivo
 * montado por volume de container — justamente o caso do pulsar em docker. Ler
 * o delta a cada segundo é previsível e custa quase nada, porque `readSince` lê
 * só o que cresceu.
 */
function FileViewer({
	path,
	width,
	aside,
	height,
	visibleRows,
	focused,
}: {
	path: string;
	width: number;
	aside: number;
	height: number;
	visibleRows: number;
	focused: boolean;
}) {
	const initial = useRef(tailFile(path, 500));
	const [lines, setLines] = useState<string[]>(initial.current.lines);
	const offsetRef = useRef(initial.current.size);
	const [follow, setFollow] = useState(true);
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [scroll, setScroll] = useState(0);

	useEffect(() => {
		if (!follow) return;
		const id = setInterval(() => {
			const { lines: fresh, size } = readSince(path, offsetRef.current);
			offsetRef.current = size;
			if (fresh.length === 0) return;
			setLines((prev) => [...prev, ...fresh].slice(-2000));
		}, POLL_MS);
		return () => clearInterval(id);
	}, [path, follow]);

	useInput(
		(input, key) => {
			if (searching) {
				if (key.return || key.escape) {
					setSearching(false);
					return;
				}
				if (key.backspace || key.delete) {
					setQuery((q) => q.slice(0, -1));
					return;
				}
				if (input && !key.ctrl && !key.meta && !key.tab)
					setQuery((q) => q + input);
				return;
			}
			if (input === "/") {
				setSearching(true);
				return;
			}
			if (input === "f") {
				setFollow((f) => !f);
				return;
			}
			if (key.upArrow) {
				// Rolar para trás desliga o "seguir": senão a tela pularia de volta
				// ao fim a cada linha nova, e ler o passado seria impossível.
				setFollow(false);
				setScroll((s) => s + 1);
				return;
			}
			if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
			if (input === "g") {
				setScroll(0);
				setFollow(true);
			}
		},
		{ isActive: focused },
	);

	const filtered = filterLines(lines, query);
	const end = Math.max(0, filtered.length - scroll);
	const visible = filtered.slice(Math.max(0, end - visibleRows), end);
	const counts = countLevels(filtered);

	return (
		<>
			<Panel
				title={`${basename(path)}${query ? ` · "${query}"` : ""}`}
				width={width}
				height={height}
				focused={focused}
				footer={
					searching ? (
						<Text color={theme.accent}>
							busca: {query}
							<Text inverse> </Text>
						</Text>
					) : undefined
				}
			>
				{visible.length === 0 ? (
					<Text color={theme.muted}>
						{query ? `nada com "${query}"` : "arquivo vazio"}
					</Text>
				) : (
					visible.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
						<Text key={i} color={colorFor(line)} wrap="truncate-end">
							{line || " "}
						</Text>
					))
				)}
			</Panel>

			{aside > 0 ? (
				<Panel title="arquivo" width={aside} height={height}>
					<Stat label="linhas" value={String(filtered.length)} width={aside} />
					<Stat
						label="tamanho"
						value={formatBytes(offsetRef.current)}
						width={aside}
						tone="muted"
					/>
					<Stat
						label="seguindo"
						value={follow ? "sim" : "não"}
						width={aside}
						tone={follow ? "ok" : "warn"}
					/>
					{scroll > 0 ? (
						<Stat
							label="acima do fim"
							value={String(scroll)}
							width={aside}
							tone="warn"
						/>
					) : null}
					<Box marginTop={1} flexDirection="column">
						<Text color={theme.border}>─ níveis ─</Text>
						<Stat
							label="erro"
							value={String(counts.error)}
							width={aside}
							tone={counts.error > 0 ? "error" : "muted"}
						/>
						<Stat
							label="aviso"
							value={String(counts.warn)}
							width={aside}
							tone={counts.warn > 0 ? "warn" : "muted"}
						/>
						<Stat
							label="info"
							value={String(counts.info)}
							width={aside}
							tone="muted"
						/>
					</Box>
				</Panel>
			) : null}
		</>
	);
}

function LiveViewer({
	dir,
	file,
	width,
	aside,
	height,
	visibleRows,
}: {
	dir: string;
	file: string;
	width: number;
	aside: number;
	height: number;
	visibleRows: number;
}) {
	const proc = useProcess(1000);
	const [backend, setBackend] = useState<Backend | null>(null);
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		void (async () => {
			const availability = await detectBackends(true);
			const chosen = preferredBackend(availability);
			if (!chosen) {
				setError("nenhum supervisor disponível nesta máquina");
				return;
			}
			setBackend(chosen);

			const path = resolve(dir, file);
			const loaded = loadConfigFile(path);
			const spec = {
				name: basename(file).replace(/\.ya?ml$/i, ""),
				mode: loaded?.form.mode ?? ("sync" as const),
				configPath: path,
				workingDir: dir,
				autostart: false,
			};

			proc.start(
				tailCommand(chosen, serviceName(spec), {
					workingDir: dir,
					label: agentLabel(spec),
				}),
				{ cwd: dir },
			);
		})();
	}, [dir, file, proc]);

	const visible = proc.lines.slice(-visibleRows);

	return (
		<>
			<Panel
				title={`ao vivo · ${basename(file)}`}
				width={width}
				height={height}
				focused={proc.running}
			>
				{error ? (
					<Text color={theme.error}>{error}</Text>
				) : visible.length === 0 ? (
					<Text color={theme.muted}>aguardando linhas…</Text>
				) : (
					visible.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
						<Text key={i} color={colorFor(line)} wrap="truncate-end">
							{line || " "}
						</Text>
					))
				)}
			</Panel>

			{aside > 0 ? (
				<Panel title="seguidor" width={aside} height={height}>
					<Stat label="backend" value={backend ?? "…"} width={aside} />
					<Stat
						label="estado"
						value={proc.running ? "seguindo" : "parado"}
						width={aside}
						tone={proc.running ? "ok" : "warn"}
					/>
					<Stat
						label="linhas"
						value={String(proc.lines.length)}
						width={aside}
					/>
					{proc.state === "failed" ? (
						<Box marginTop={1}>
							<Text color={theme.warn} wrap="wrap">
								o seguidor encerrou — o serviço está instalado e rodando?
							</Text>
						</Box>
					) : null}
				</Panel>
			) : null}
		</>
	);
}

function chipsFor(source: Source | undefined, dir: string): Chip[] {
	if (!source) return [{ label: "pasta", value: basename(dir), tone: "muted" }];
	return source.kind === "file"
		? [
				{ label: "modo", value: "arquivo", tone: "muted" },
				{ label: "fonte", value: source.name },
			]
		: [
				{ label: "modo", value: "ao vivo", tone: "ok" },
				{ label: "fonte", value: basename(source.file) },
			];
}

function countLevels(lines: string[]): {
	error: number;
	warn: number;
	info: number;
} {
	const counts = { error: 0, warn: 0, info: 0 };
	for (const line of lines) {
		const level = levelOf(line);
		if (level === "error") counts.error++;
		else if (level === "warn") counts.warn++;
		else counts.info++;
	}
	return counts;
}

function colorFor(line: string): string | undefined {
	const level = levelOf(line);
	if (level === "error") return theme.error;
	if (level === "warn") return theme.warn;
	if (level === "debug") return theme.muted;
	return undefined;
}

/** Reexportado só para manter o glifo do cursor consistente entre telas. */
export const CURSOR = glyph.cursor;
