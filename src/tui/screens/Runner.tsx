import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { loadConfigFile } from "../../core/config/loadConfig";
import { levelOf } from "../../core/run/logLines";
import { argsFor, pulsarCommand } from "../../core/run/pulsarCommand";
import {
	type Chip,
	layout,
	Panel,
	RAIL_WIDTH,
	Shell,
	Stat,
} from "../components/Shell";
import { useProcess } from "../hooks/useProcess";
import { useSpinner } from "../hooks/useSpinner";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { glyph, theme } from "../theme";

/**
 * Execução em primeiro plano: opções à esquerda, saída ao vivo no centro,
 * números à direita.
 *
 * A janela de saída mostra só as últimas linhas — um `sync` fica no ar por
 * dias, e guardar esse histórico não é papel da TUI. Quem quer o histórico
 * completo usa a tela de logs, que lê os arquivos do winston.
 */

export function RunnerScreen({
	file,
	onExit,
	onInstallService,
}: {
	file: string;
	onExit: () => void;
	onInstallService: () => void;
}) {
	const { columns, rows } = useTerminalSize();
	const l = layout(columns, rows, RAIL_WIDTH);

	const loaded = loadConfigFile(file);
	const mode = loaded?.form.mode ?? "sync";
	const [verbose, setVerbose] = useState(false);
	const [full, setFull] = useState(false);
	const proc = useProcess();
	const frame = useSpinner(proc.running);

	useInput((input, key) => {
		if (proc.running) {
			// Com processo vivo a única decisão é parar: sair da tela esconderia
			// um sync ativo do usuário.
			if (input === "s" || key.escape) proc.stop();
			return;
		}
		if (key.escape) {
			onExit();
			return;
		}
		if (key.return) {
			const extra: string[] = [];
			if (verbose && mode === "sync") extra.push("--verbose");
			if (full && mode === "sync") extra.push("--full");
			proc.start(pulsarCommand(argsFor(mode, file, extra)));
			return;
		}
		if (input === "v" && mode === "sync") setVerbose((v) => !v);
		if (input === "f" && mode === "sync") setFull((f) => !f);
		if (input === "b") onInstallService();
	});

	if (!loaded)
		return (
			<Shell
				chips={[{ label: "erro", value: basename(file), tone: "error" }]}
				columns={columns}
				rows={rows}
				hints={[{ keys: "esc", label: "voltar" }]}
			>
				<Panel title="rodar" width={columns} height={l.body}>
					<Text color={theme.error}>não consegui ler {file}</Text>
					<Text color={theme.muted}>
						o arquivo é uma config do pulsar (command.sync/migrate/ttl)?
					</Text>
				</Panel>
			</Shell>
		);

	const chips: Chip[] = [
		{ label: "config", value: basename(file), tone: "muted" },
		{ label: "modo", value: mode },
		{
			label: "estado",
			value: stateLabel(proc.state),
			tone: stateTone(proc.state),
		},
	];

	const visible = proc.lines.slice(-(l.panelRows - 1));

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			/*
			 * Com o processo VIVO, trocar de aba desmontaria a tela e mataria o
			 * filho — um sync não pode morrer por um `2` digitado sem querer. As
			 * abas continuam à vista (a geometria não muda), mas inertes: a única
			 * decisão aqui é parar.
			 */
			lockTabs={proc.running}
			hints={
				proc.running
					? [{ keys: "s", label: "parar (SIGTERM — salva o progresso)" }]
					: [
							{ keys: "enter", label: "rodar" },
							{ keys: "b", label: "background" },
							...(mode === "sync"
								? [
										{ keys: "v", label: "verbose" },
										{ keys: "f", label: "dump completo" },
									]
								: []),
							{ keys: "esc", label: "voltar" },
						]
			}
		>
			<Panel title="opções" width={l.rail} height={l.body}>
				{mode === "sync" ? (
					<>
						<Toggle on={verbose} label="verbose" keyHint="v" />
						<Toggle on={full} label="--full" keyHint="f" tone="warn" />
					</>
				) : (
					<Text color={theme.muted}>sem opções para {mode}</Text>
				)}
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.border}>─ origem ─</Text>
					<Text wrap="truncate-end">{loaded.form.source.db}</Text>
					{mode !== "ttl" ? (
						<>
							<Text color={theme.border}>─ destino ─</Text>
							<Text wrap="truncate-end">{loaded.form.destination.db}</Text>
						</>
					) : null}
				</Box>
			</Panel>

			<Panel
				title="saída"
				width={l.center}
				height={l.body}
				focused={proc.running}
			>
				{visible.length === 0 ? (
					<Text color={theme.muted}>
						{proc.state === "idle" ? "enter para rodar" : "sem saída ainda…"}
					</Text>
				) : (
					visible.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: log é append-only
						<Text key={i} color={colorFor(line)} wrap="truncate-end">
							{line || " "}
						</Text>
					))
				)}
			</Panel>

			{l.aside > 0 ? (
				<Panel title="execução" width={l.aside} height={l.body}>
					<RunStats
						proc={proc}
						frame={frame}
						width={l.aside}
						collections={loaded.form.collections.length}
					/>
				</Panel>
			) : null}
		</Shell>
	);
}

function Toggle({
	on,
	label,
	keyHint,
	tone,
}: {
	on: boolean;
	label: string;
	keyHint: string;
	tone?: "warn";
}) {
	return (
		<Text color={on ? (tone === "warn" ? theme.warn : theme.ok) : theme.muted}>
			{on ? glyph.checked : glyph.unchecked} {label}{" "}
			<Text color={theme.border}>({keyHint})</Text>
		</Text>
	);
}

function RunStats({
	proc,
	frame,
	width,
	collections,
}: {
	proc: ReturnType<typeof useProcess>;
	frame: number;
	width: number;
	collections: number;
}) {
	const secs = proc.startedAt
		? Math.floor((Date.now() - proc.startedAt) / 1000)
		: 0;

	return (
		<Box flexDirection="column">
			<Text color={stateTextColor(proc.state)} bold>
				{proc.running ? `${glyph.spinner[frame % glyph.spinner.length]} ` : ""}
				{stateLabel(proc.state)}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<Stat
					label="tempo"
					value={proc.startedAt ? formatDuration(secs) : "—"}
					width={width}
				/>
				<Stat label="linhas" value={String(proc.lines.length)} width={width} />
				<Stat label="colls" value={String(collections)} width={width} />
				{proc.exitCode !== null ? (
					<Stat
						label="código"
						value={String(proc.exitCode)}
						width={width}
						tone={proc.exitCode === 0 ? "ok" : "error"}
					/>
				) : null}
			</Box>

			{proc.running ? (
				<Box marginTop={1}>
					<Text color={theme.muted} wrap="wrap">
						parar com <Text color={theme.accent}>s</Text> envia SIGTERM: o
						pulsar grava o resume token antes de sair.
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

function colorFor(line: string): string | undefined {
	const level = levelOf(line);
	if (level === "error") return theme.error;
	if (level === "warn") return theme.warn;
	if (level === "debug") return theme.muted;
	return undefined;
}

function stateLabel(state: ReturnType<typeof useProcess>["state"]): string {
	if (state === "running") return "rodando";
	if (state === "exited") return "encerrado";
	if (state === "failed") return "falhou";
	return "parado";
}

function stateTone(
	state: ReturnType<typeof useProcess>["state"],
): Chip["tone"] {
	if (state === "running") return "ok";
	if (state === "failed") return "error";
	if (state === "exited") return "muted";
	return "muted";
}

function stateTextColor(state: ReturnType<typeof useProcess>["state"]): string {
	if (state === "running") return theme.ok;
	if (state === "failed") return theme.error;
	return theme.muted;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}min ${seconds % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}min`;
}
