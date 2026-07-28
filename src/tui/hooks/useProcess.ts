import { type ChildProcess, spawn } from "node:child_process";
import { useCallback, useEffect, useRef, useState } from "react";
import { LineBuffer } from "../../core/run/logLines";
import type { Command } from "../../core/run/pulsarCommand";

/**
 * Ciclo de vida de um processo filho do pulsar disparado pela TUI.
 *
 * Três cuidados que não são opcionais:
 *
 * 1. **Encerrar com SIGTERM, não SIGKILL.** O `sync` trata SIGTERM fazendo
 *    flush do resume token e das fronteiras de dump antes de sair — matar com
 *    -9 joga fora até ~5s de progresso e força re-dump na volta. O SIGKILL só
 *    entra como último recurso, depois do prazo.
 * 2. **Nunca deixar órfão.** Se a TUI morrer com o filho vivo, sobra um sync
 *    escrevendo no destino sem ninguém sabendo. O handler de `exit` do
 *    processo garante o sinal.
 * 3. **Não redesenhar a cada linha.** Um dump verboso emite centenas de linhas
 *    por segundo; re-renderizar em cada uma trava o terminal. O estado é
 *    atualizado em intervalo fixo.
 */

export type ProcState = "idle" | "running" | "exited" | "failed";

const REDRAW_MS = 150;
const SIGKILL_AFTER_MS = 35_000; // > PULSAR_SHUTDOWN_TIMEOUT_MS (default 30s)

export function useProcess(maxLines = 500) {
	const [state, setState] = useState<ProcState>("idle");
	const [lines, setLines] = useState<string[]>([]);
	const [exitCode, setExitCode] = useState<number | null>(null);
	const [startedAt, setStartedAt] = useState<number | null>(null);

	const bufferRef = useRef(new LineBuffer(maxLines));
	const childRef = useRef<ChildProcess | null>(null);
	const dirtyRef = useRef(false);
	const killTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Redesenho em intervalo fixo, e só quando algo mudou.
	useEffect(() => {
		const id = setInterval(() => {
			if (!dirtyRef.current) return;
			dirtyRef.current = false;
			setLines(bufferRef.current.all());
		}, REDRAW_MS);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		const killOnExit = () => {
			childRef.current?.kill("SIGTERM");
		};
		process.on("exit", killOnExit);
		return () => {
			process.off("exit", killOnExit);
			if (killTimerRef.current) clearTimeout(killTimerRef.current);
			childRef.current?.kill("SIGTERM");
		};
	}, []);

	const start = useCallback(
		(
			command: Command,
			opts?: { cwd?: string; env?: Record<string, string> },
		) => {
			if (childRef.current) return;

			bufferRef.current.clear();
			setLines([]);
			setExitCode(null);
			setState("running");
			setStartedAt(Date.now());

			const child = spawn(command.cmd, command.args, {
				cwd: opts?.cwd ?? process.cwd(),
				env: {
					...process.env,
					// Sem TTY o pulsar já troca barras pelo bloco STATUS; desligar cor
					// evita escapes ANSI atravessando o layout do ink.
					NO_COLOR: "1",
					FORCE_COLOR: "0",
					...opts?.env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			childRef.current = child;

			const consume = (chunk: Buffer) => {
				bufferRef.current.push(chunk.toString("utf8"));
				dirtyRef.current = true;
			};
			child.stdout?.on("data", consume);
			child.stderr?.on("data", consume);

			child.on("error", (err) => {
				bufferRef.current.push(`\n[ TUI ] falha ao iniciar: ${err.message}\n`);
				childRef.current = null;
				setLines(bufferRef.current.all());
				setState("failed");
			});

			child.on("exit", (code, signal) => {
				bufferRef.current.flush();
				childRef.current = null;
				if (killTimerRef.current) clearTimeout(killTimerRef.current);
				setLines(bufferRef.current.all());
				setExitCode(code);
				setState(code === 0 || signal === "SIGTERM" ? "exited" : "failed");
			});
		},
		[],
	);

	/** SIGTERM e, só se o processo ignorar o prazo, SIGKILL. */
	const stop = useCallback(() => {
		const child = childRef.current;
		if (!child) return;
		child.kill("SIGTERM");
		killTimerRef.current = setTimeout(() => {
			childRef.current?.kill("SIGKILL");
		}, SIGKILL_AFTER_MS);
	}, []);

	return {
		state,
		lines,
		exitCode,
		startedAt,
		start,
		stop,
		running: state === "running",
	};
}
