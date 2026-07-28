import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { loadConfigFile } from "../../core/config/loadConfig";
import { levelOf } from "../../core/run/logLines";
import { argsFor, pulsarCommand } from "../../core/run/pulsarCommand";
import { Frame } from "../components/Frame";
import { useProcess } from "../hooks/useProcess";
import { useSpinner } from "../hooks/useSpinner";
import { theme } from "../theme";

/**
 * Roda uma config em primeiro plano, com a saída ao vivo dentro da TUI.
 *
 * A janela de log mostra as últimas linhas e mais nada: um `sync` fica no ar
 * por dias, e a TUI não é o lugar de guardar esse histórico — quem quer o
 * histórico completo abre a tela de logs, que lê os arquivos do winston.
 */

const VIEWPORT = 16;

export function RunnerScreen({
	file,
	onExit,
	onInstallService,
}: {
	file: string;
	onExit: () => void;
	onInstallService: () => void;
}) {
	const loaded = loadConfigFile(file);
	const mode = loaded?.form.mode ?? "sync";
	const [verbose, setVerbose] = useState(false);
	const [full, setFull] = useState(false);
	const proc = useProcess();
	const frame = useSpinner(proc.running);

	function run() {
		const extra: string[] = [];
		if (verbose && mode === "sync") extra.push("--verbose");
		if (full && mode === "sync") extra.push("--full");
		proc.start(pulsarCommand(argsFor(mode, file, extra)));
	}

	useInput((input, key) => {
		if (proc.running) {
			// Enquanto roda, só existe uma decisão: parar. Sair da tela com o
			// processo vivo esconderia um sync ativo do usuário.
			if (input === "s" || key.escape) proc.stop();
			return;
		}

		if (key.escape) {
			onExit();
			return;
		}
		if (key.return) {
			run();
			return;
		}
		if (input === "v" && mode === "sync") setVerbose((v) => !v);
		if (input === "f" && mode === "sync") setFull((f) => !f);
		if (input === "b") onInstallService();
	});

	if (!loaded)
		return (
			<Frame
				title="rodar"
				hints={[{ keys: "esc", label: "voltar" }]}
				status={{ text: `não consegui ler ${file}`, tone: "error" }}
			>
				<Text color={theme.muted}>
					O arquivo existe e é uma config do pulsar (command.sync/migrate/ttl)?
				</Text>
			</Frame>
		);

	const visible = proc.lines.slice(-VIEWPORT);

	return (
		<Frame
			title={`rodar · ${mode}`}
			subtitle={basename(file)}
			hints={
				proc.running
					? [{ keys: "s", label: "parar (SIGTERM, salva o progresso)" }]
					: [
							{ keys: "enter", label: "rodar aqui" },
							{ keys: "b", label: "rodar em background" },
							...(mode === "sync"
								? [
										{ keys: "v", label: "verbose" },
										{ keys: "f", label: "dump completo" },
									]
								: []),
							{ keys: "esc", label: "voltar" },
						]
			}
			status={statusLine(proc, frame)}
		>
			<Box flexDirection="column">
				<Box>
					<Text color={theme.muted}>
						{loaded.form.source.db}
						{mode !== "ttl" ? ` → ${loaded.form.destination.db}` : ""} ·{" "}
						{loaded.form.collections.length} collections
					</Text>
				</Box>

				{mode === "sync" && !proc.running ? (
					<Box marginTop={1}>
						<Text color={verbose ? theme.ok : theme.muted}>
							{verbose ? "[x]" : "[ ]"} verbose
						</Text>
						<Text color={full ? theme.warn : theme.muted}>
							{"   "}
							{full ? "[x]" : "[ ]"} --full (re-dumpa tudo, ignora os carimbos)
						</Text>
					</Box>
				) : null}

				<Box
					flexDirection="column"
					marginTop={1}
					borderStyle="round"
					borderColor={theme.muted}
					paddingX={1}
					minHeight={VIEWPORT + 2}
				>
					{visible.length === 0 ? (
						<Text color={theme.muted}>
							{proc.state === "idle" ? "enter para rodar" : "sem saída ainda…"}
						</Text>
					) : (
						visible.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: log é append-only, o índice é estável
							<Text key={i} color={colorFor(line)} wrap="truncate-end">
								{line || " "}
							</Text>
						))
					)}
				</Box>
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

function statusLine(
	proc: ReturnType<typeof useProcess>,
	frame: number,
): { text: string; tone?: "ok" | "warn" | "error" } | undefined {
	if (proc.state === "running") {
		const secs = proc.startedAt
			? Math.floor((Date.now() - proc.startedAt) / 1000)
			: 0;
		const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		return {
			text: `${spin[frame % spin.length]} rodando há ${formatDuration(secs)}`,
		};
	}
	if (proc.state === "exited")
		return {
			text: `processo encerrado (código ${proc.exitCode ?? 0})`,
			tone: "ok",
		};
	if (proc.state === "failed")
		return {
			text: `processo falhou (código ${proc.exitCode ?? "?"}) — veja as linhas acima`,
			tone: "error",
		};
	return undefined;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}min ${seconds % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}min`;
}
