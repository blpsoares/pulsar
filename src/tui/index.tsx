import { render } from "ink";
import { App } from "./App";
import { MouseProvider } from "./mouse/MouseProvider";

/**
 * Entrypoint da TUI.
 *
 * Exige TTY: sem terminal interativo não há como ler teclas nem redesenhar a
 * tela, e o ink cuspiria escape codes num pipe ou num container. Nesse caso a
 * mensagem manda usar os subcomandos, que funcionam sem TTY por design.
 */

/** Tela alternativa: o mesmo buffer que vim/htop/k9s usam. */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export async function startTui(dir = process.cwd()): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(
			"A TUI precisa de um terminal interativo (TTY).\n" +
				"Sem TTY, use os subcomandos: pulsar sync <arquivo.yml>, pulsar migrate, pulsar ttl.",
		);
		process.exitCode = 1;
		return;
	}

	// Sem a tela alternativa, um app de tela cheia deixa dezenas de frames
	// desenhados no scrollback — sair da TUI entregaria o terminal cheio de
	// lixo. Com ela, o conteúdo anterior volta intacto ao sair.
	process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);

	// Restaura mesmo em morte anormal: sem isto, um crash deixaria o terminal
	// sem cursor e preso na tela alternativa, exigindo `reset`.
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
	};
	process.once("exit", restore);
	// SIGTERM/SIGHUP precisam RESTAURAR **e encerrar**. Registrar um handler que
	// só restaura substitui a ação padrão do sinal (terminar) por nada: a TUI
	// passaria a IGNORAR `kill` e o fechamento do terminal, ficando viva e presa.
	for (const sinal of ["SIGTERM", "SIGHUP"] as const)
		process.once(sinal, () => {
			restore();
			// 128 + número do sinal é a convenção de shell para "morto por sinal".
			process.exit(sinal === "SIGTERM" ? 143 : 129);
		});
	// Um crash não pode virar uma TUI viva em estado inconsistente: restaura a
	// tela, mostra o erro (que o alternate screen esconderia) e sai com falha.
	process.once("uncaughtException", (err) => {
		restore();
		console.error(err);
		process.exit(1);
	});

	const instance = render(
		<MouseProvider>
			<App dir={dir} />
		</MouseProvider>,
		{
			// O Ctrl+C é tratado no App: ele desmonta os componentes, e é o desmonte
			// que manda SIGTERM num sync disparado pela TUI (que então grava o resume
			// token). Deixar o ink matar na hora deixaria filho órfão.
			exitOnCtrlC: false,
		},
	);

	try {
		await instance.waitUntilExit();
	} finally {
		restore();
	}
}
