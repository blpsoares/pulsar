import { basename, resolve } from "node:path";
import { Box, type DOMElement, Text, useInput } from "ink";
import { type RefObject, useEffect, useRef, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import { loadConfigFile } from "../../core/config/loadConfig";
import { formatBytes } from "../../core/inspect/collStats";
import {
	filterLines,
	listLogFiles,
	logWindow,
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
import { useClickable } from "../mouse/MouseProvider";
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
				{ keys: "pgup/pgdn", label: "página" },
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
					onPick={(i) => {
						setIndex(i);
						setPane("sources");
					}}
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
					focused={pane === "content"}
				/>
			)}
		</Shell>
	);
}

function SourceList({
	sources,
	index,
	focused,
	onPick,
}: {
	sources: Source[];
	index: number;
	focused: boolean;
	onPick: (index: number) => void;
}) {
	// As linhas são achatadas (cabeçalhos + fontes) para que o clique saiba
	// exatamente qual fonte está sob o cursor — contar só as fontes erraria o
	// alvo por uma linha a cada cabeçalho acima dela.
	const rows: (
		| { kind: "header"; label: string }
		| {
				kind: "source";
				source: Source;
				index: number;
		  }
	)[] = [];
	let lastKind: string | null = null;
	for (const [i, s] of sources.entries()) {
		if (s.kind !== lastKind) {
			rows.push({
				kind: "header",
				label: s.kind === "file" ? "─ arquivo ─" : "─ ao vivo ─",
			});
			lastKind = s.kind;
		}
		rows.push({ kind: "source", source: s, index: i });
	}

	const ref = useClickable({
		onClick: ({ row }) => {
			const target = rows[row];
			if (target?.kind === "source") onPick(target.index);
		},
		onWheel: (direction) => {
			if (sources.length === 0) return;
			onPick(Math.max(0, Math.min(sources.length - 1, index + direction)));
		},
	});

	if (sources.length === 0)
		return <Text color={theme.muted}>nada para ler</Text>;

	return (
		<Box flexDirection="column" ref={ref}>
			{rows.map((row, i) =>
				row.kind === "header" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: linha é posicional
					<Text key={i} color={theme.border}>
						{row.label}
					</Text>
				) : (
					<Text
						// biome-ignore lint/suspicious/noArrayIndexKey: linha é posicional
						key={i}
						color={
							row.index === index
								? focused
									? theme.selection
									: theme.label
								: theme.muted
						}
						bold={row.index === index}
						wrap="truncate-end"
					>
						{row.index === index ? "▍" : " "}
						{row.source.kind === "file"
							? row.source.name
							: basename(row.source.file)}
					</Text>
				),
			)}
		</Box>
	);
}

type Viewport = {
	/** vai no Box que envolve as linhas — é o que a roda do mouse enxerga */
	ref: RefObject<DOMElement | null>;
	/** a janela que cabe na tela */
	visible: string[];
	/** as linhas depois da busca, para contagem e níveis */
	filtered: string[];
	query: string;
	searching: boolean;
	follow: boolean;
	scroll: number;
};

/**
 * Rolagem, busca e "seguir" — os mesmos para arquivo e ao vivo.
 *
 * Antes só o visualizador de ARQUIVO tinha isso: no ao vivo a tela era um
 * `slice(-visibleRows)` fixo, então não havia como olhar para trás justamente
 * onde mais importa (o erro que passou correndo enquanto o dump cuspia linhas).
 *
 * Enquanto se lê o passado, as linhas exibidas ficam CONGELADAS. Rolar sobre um
 * log que continua crescendo, sem congelar, empurra o texto para cima a cada
 * linha nova e a linha que você estava lendo foge da tela.
 */
function useLogViewport(
	lines: string[],
	{ focused, visibleRows }: { focused: boolean; visibleRows: number },
): Viewport {
	const [follow, setFollow] = useState(true);
	const [scroll, setScroll] = useState(0);
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const frozen = useRef<string[] | null>(null);

	const source = follow ? lines : (frozen.current ?? lines);
	const filtered = filterLines(source, query);
	const window = logWindow(filtered, scroll, visibleRows);

	/** `scroll` é a distância até o FIM: 0 = colado no fim, seguindo. */
	function scrollTo(next: number) {
		const { scroll: clamped } = logWindow(filtered, next, visibleRows);
		frozen.current = clamped === 0 ? null : (frozen.current ?? lines);
		setFollow(clamped === 0);
		setScroll(clamped);
	}

	const ref = useClickable({
		onWheel: (direction) => {
			if (!focused) return;
			// direction -1 é roda para cima = voltar no tempo = afastar do fim.
			scrollTo(scroll - direction * 3);
		},
	});

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
				scrollTo(follow ? 1 : 0);
				return;
			}
			if (input === "g") {
				scrollTo(0);
				return;
			}
			if (key.upArrow || input === "k") scrollTo(scroll + 1);
			else if (key.downArrow || input === "j") scrollTo(scroll - 1);
			else if (key.pageUp) scrollTo(scroll + visibleRows);
			else if (key.pageDown) scrollTo(scroll - visibleRows);
		},
		{ isActive: focused },
	);

	return {
		ref,
		visible: window.visible,
		filtered,
		query,
		searching,
		follow,
		scroll: window.scroll,
	};
}

/** As linhas em si, num Box que a roda do mouse consegue localizar. */
function LogLines({ viewport, empty }: { viewport: Viewport; empty: string }) {
	return (
		<Box flexDirection="column" flexGrow={1} ref={viewport.ref}>
			{viewport.visible.length === 0 ? (
				<Text color={theme.muted}>{empty}</Text>
			) : (
				viewport.visible.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
					<Text key={i} color={colorFor(line)} wrap="truncate-end">
						{line || " "}
					</Text>
				))
			)}
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

	const view = useLogViewport(lines, { focused, visibleRows });
	const { query, searching, follow, scroll } = view;

	// O arquivo continua sendo lido mesmo pausado: o que congela é a JANELA na
	// tela (no viewport), não a coleta. Parar de ler deixaria um buraco no
	// histórico ao voltar a seguir.
	useEffect(() => {
		const id = setInterval(() => {
			const { lines: fresh, size } = readSince(path, offsetRef.current);
			offsetRef.current = size;
			if (fresh.length === 0) return;
			setLines((prev) => [...prev, ...fresh].slice(-2000));
		}, POLL_MS);
		return () => clearInterval(id);
	}, [path]);

	const counts = countLevels(view.filtered);

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
				<LogLines
					viewport={view}
					empty={query ? `nada com "${query}"` : "arquivo vazio"}
				/>
			</Panel>

			{aside > 0 ? (
				<Panel title="arquivo" width={aside} height={height}>
					<Stat
						label="linhas"
						value={String(view.filtered.length)}
						width={aside}
					/>
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
	focused,
}: {
	dir: string;
	file: string;
	width: number;
	aside: number;
	height: number;
	visibleRows: number;
	focused: boolean;
}) {
	const proc = useProcess(1000);
	const [backend, setBackend] = useState<Backend | null>(null);
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		void (async () => {
			const availability = await detectBackends(dir);
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

	const view = useLogViewport(proc.lines, { focused, visibleRows });

	return (
		<>
			<Panel
				title={`ao vivo · ${basename(file)}${
					view.query ? ` · "${view.query}"` : ""
				}`}
				width={width}
				height={height}
				focused={focused}
				footer={
					view.searching ? (
						<Text color={theme.accent}>
							busca: {view.query}
							<Text inverse> </Text>
						</Text>
					) : undefined
				}
			>
				{error ? (
					<Text color={theme.error}>{error}</Text>
				) : (
					<LogLines
						viewport={view}
						empty={
							view.query ? `nada com "${view.query}"` : "aguardando linhas…"
						}
					/>
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
						value={String(view.filtered.length)}
						width={aside}
					/>
					<Stat
						label="rolagem"
						value={view.follow ? "no fim" : `${view.scroll} acima`}
						width={aside}
						tone={view.follow ? "ok" : "warn"}
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
