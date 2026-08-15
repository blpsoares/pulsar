import { DISABLE_MOUSE, ENABLE_MOUSE, ENTER_ALT, LEAVE_ALT } from "./ansi";

/**
 * Empresta o terminal para um comando interativo (hoje: o `sudo` pedindo senha)
 * e o devolve à TUI depois.
 *
 * A restauração está em `finally` e isso NÃO é estilo: se o processo sair daqui
 * sem reentrar no alternate screen e sem religar o raw mode, o usuário fica com
 * um terminal sem eco, digitando às cegas, e a única saída é `reset`. Qualquer
 * caminho de erro tem que passar pela restauração.
 */

export type TerminalIo = {
	stdout: { write(s: string): void };
	stdin: { isTTY?: boolean; setRawMode?(v: boolean): void };
};

export async function withTerminal<T>(
	fn: () => Promise<T>,
	io: TerminalIo = process as unknown as TerminalIo,
): Promise<T> {
	// Sem TTY (teste, container, pipe) não há nada para soltar nem restaurar.
	if (!io.stdin.isTTY) return fn();

	io.stdin.setRawMode?.(false);
	io.stdout.write(DISABLE_MOUSE);
	io.stdout.write(LEAVE_ALT);

	try {
		return await fn();
	} finally {
		io.stdout.write(ENTER_ALT);
		io.stdout.write(ENABLE_MOUSE);
		io.stdin.setRawMode?.(true);
	}
}
