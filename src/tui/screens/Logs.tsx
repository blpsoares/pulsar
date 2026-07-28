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
import { Frame } from "../components/Frame";
import { Select } from "../components/Select";
import { useProcess } from "../hooks/useProcess";
import { theme } from "../theme";

/**
 * Duas leituras de log, que respondem a perguntas diferentes:
 *
 * - ARQUIVO (`./logs/*.log`): o histórico que o winston grava sempre, mesmo
 *   quando ninguém está olhando e independente de verbose. É onde se investiga
 *   o que aconteceu ontem às 3h.
 * - AO VIVO: o stdout do serviço que está rodando AGORA em background, lido
 *   pelo seguidor nativo do supervisor (journalctl/pm2/docker/tail).
 *
 * Elas não se substituem: o arquivo não tem o que o supervisor imprimiu antes
 * do pulsar inicializar o logger, e o supervisor não guarda o histórico
 * rotacionado.
 */

const VIEWPORT = 20;
const POLL_MS = 1000;

type View =
	| { name: "menu" }
	| { name: "pick-file" }
	| { name: "file"; path: string }
	| { name: "pick-live" }
	| { name: "live"; label: string };

export function LogsScreen({
	dir,
	onExit,
}: {
	dir: string;
	onExit: () => void;
}) {
	const [view, setView] = useState<View>({ name: "menu" });

	// Sem isto o menu de logs não tinha saída: o Select não trata esc, e a única
	// forma de voltar ao início seria matar a TUI.
	useInput(
		(_input, key) => {
			if (key.escape) onExit();
		},
		{ isActive: view.name === "menu" },
	);

	if (view.name === "menu")
		return (
			<Frame
				title="logs"
				subtitle={dir}
				hints={[
					{ keys: "↑↓", label: "navegar" },
					{ keys: "enter", label: "abrir" },
					{ keys: "esc", label: "voltar" },
				]}
			>
				<Select
					items={[
						{
							value: "file" as const,
							label: "logs gravados",
							hint: "./logs/*.log — histórico completo, sobrevive a restart",
						},
						{
							value: "live" as const,
							label: "ao vivo",
							hint: "stdout do serviço rodando agora em background",
						},
					]}
					onSelect={(v) =>
						setView(
							v === "file" ? { name: "pick-file" } : { name: "pick-live" },
						)
					}
				/>
			</Frame>
		);

	if (view.name === "pick-file")
		return (
			<FilePicker
				dir={dir}
				onPick={(path) => setView({ name: "file", path })}
				onBack={() => setView({ name: "menu" })}
			/>
		);

	if (view.name === "file")
		return (
			<FileViewer
				path={view.path}
				onBack={() => setView({ name: "pick-file" })}
			/>
		);

	if (view.name === "pick-live")
		return (
			<LivePicker
				dir={dir}
				onBack={() => setView({ name: "menu" })}
				onPick={(label) => setView({ name: "live", label })}
			/>
		);

	return (
		<LiveViewer
			dir={dir}
			label={view.label}
			onBack={() => setView({ name: "pick-live" })}
		/>
	);
}

function FilePicker({
	dir,
	onPick,
	onBack,
}: {
	dir: string;
	onPick: (path: string) => void;
	onBack: () => void;
}) {
	const files = listLogFiles(dir);
	useInput((_i, key) => {
		if (key.escape) onBack();
	});

	return (
		<Frame
			title="logs gravados"
			subtitle={`${dir}/logs`}
			hints={[
				{ keys: "enter", label: "abrir" },
				{ keys: "esc", label: "voltar" },
			]}
		>
			<Select
				items={files.map((f) => ({
					value: f.path,
					label: f.name,
					hint: `${formatBytes(f.size)} · ${new Date(f.modifiedAt).toLocaleString()}`,
				}))}
				onSelect={onPick}
				emptyMessage="nenhum arquivo em ./logs — rode algo primeiro"
			/>
		</Frame>
	);
}

/**
 * Visualizador com "seguir" por polling de offset. `fs.watch` seria mais
 * elegante, mas é notoriamente inconsistente entre plataformas (e não dispara
 * em arquivo montado por volume de container, justamente o caso do pulsar em
 * docker). Ler o delta a cada segundo é previsível e custa quase nada, porque
 * `readSince` lê só o que cresceu.
 */
function FileViewer({ path, onBack }: { path: string; onBack: () => void }) {
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

	useInput((input, key) => {
		if (searching) {
			if (key.return || key.escape) {
				setSearching(false);
				return;
			}
			if (key.backspace || key.delete) {
				setQuery((q) => q.slice(0, -1));
				return;
			}
			if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
			return;
		}

		if (key.escape) {
			onBack();
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
			// para o fim a cada linha nova, e ler o passado seria impossível.
			setFollow(false);
			setScroll((s) => s + 1);
			return;
		}
		if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
		if (input === "g") {
			setScroll(0);
			setFollow(true);
		}
	});

	const filtered = filterLines(lines, query);
	const end = Math.max(0, filtered.length - scroll);
	const visible = filtered.slice(Math.max(0, end - VIEWPORT), end);

	return (
		<Frame
			title={`log · ${basename(path)}`}
			subtitle={`${filtered.length} linhas${query ? ` com "${query}"` : ""}`}
			hints={[
				{ keys: "↑↓", label: "rolar" },
				{ keys: "/", label: "buscar" },
				{ keys: "f", label: `seguir: ${follow ? "on" : "off"}` },
				{ keys: "g", label: "ir pro fim" },
				{ keys: "esc", label: "voltar" },
			]}
			status={
				searching
					? { text: `busca: ${query}▌` }
					: follow
						? { text: "seguindo o arquivo", tone: "ok" }
						: { text: `pausado · ${scroll} linhas acima do fim`, tone: "warn" }
			}
		>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.muted}
				paddingX={1}
				minHeight={VIEWPORT + 2}
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
			</Box>
		</Frame>
	);
}

/** Descobre quais serviços dá para seguir: cruza as configs da pasta com o backend disponível. */
function LivePicker({
	dir,
	onPick,
	onBack,
}: {
	dir: string;
	onPick: (file: string) => void;
	onBack: () => void;
}) {
	const configs = detectConfigs(dir).filter((c) => c.kind !== "desconhecido");
	useInput((_i, key) => {
		if (key.escape) onBack();
	});

	return (
		<Frame
			title="log ao vivo"
			subtitle={dir}
			hints={[
				{ keys: "enter", label: "seguir" },
				{ keys: "esc", label: "voltar" },
			]}
		>
			<Text color={theme.muted}>
				De qual serviço? (precisa ter sido instalado em background)
			</Text>
			<Box marginTop={1}>
				<Select
					items={configs.map((c) => ({
						value: c.file,
						label: c.file,
						hint: `${c.kind}${c.destDb ? ` → ${c.destDb}` : ""}`,
					}))}
					onSelect={onPick}
					emptyMessage="nenhuma config nesta pasta"
				/>
			</Box>
		</Frame>
	);
}

function LiveViewer({
	dir,
	label,
	onBack,
}: {
	dir: string;
	label: string;
	onBack: () => void;
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

			const path = resolve(dir, label);
			const loaded = loadConfigFile(path);
			const spec = {
				name: basename(label).replace(/\.ya?ml$/i, ""),
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
	}, [dir, label, proc]);

	useInput((_i, key) => {
		if (key.escape) {
			proc.stop();
			onBack();
		}
	});

	const visible = proc.lines.slice(-VIEWPORT);

	return (
		<Frame
			title={`ao vivo · ${basename(label)}`}
			subtitle={backend ? `via ${backend}` : "detectando supervisor…"}
			hints={[{ keys: "esc", label: "parar de seguir e voltar" }]}
			status={
				error
					? { text: error, tone: "error" }
					: proc.state === "failed"
						? {
								text: "o seguidor encerrou — o serviço está instalado e rodando?",
								tone: "warn",
							}
						: undefined
			}
		>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.muted}
				paddingX={1}
				minHeight={VIEWPORT + 2}
			>
				{visible.length === 0 ? (
					<Text color={theme.muted}>aguardando linhas…</Text>
				) : (
					visible.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
						<Text key={i} color={colorFor(line)} wrap="truncate-end">
							{line || " "}
						</Text>
					))
				)}
			</Box>
		</Frame>
	);
}

function colorFor(line: string): string | undefined {
	const level = levelOf(line);
	if (level === "error") return theme.error;
	if (level === "warn") return theme.warn;
	if (level === "debug") return theme.muted;
	return undefined;
}
