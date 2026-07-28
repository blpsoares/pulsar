import { render } from "ink";
import { App } from "./App";

/**
 * Entrypoint da TUI.
 *
 * Exige TTY: sem terminal interativo não há como ler teclas nem redesenhar a
 * tela, e o ink renderizaria um borrão de escape codes num pipe ou num
 * container. Nesse caso a mensagem manda usar os subcomandos, que funcionam
 * sem TTY por design.
 */
export async function startTui(dir = process.cwd()): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error(
			"A TUI precisa de um terminal interativo (TTY).\n" +
				"Sem TTY, use os subcomandos: pulsar sync <arquivo.yml>, pulsar migrate, pulsar ttl.",
		);
		process.exitCode = 1;
		return;
	}

	const instance = render(<App dir={dir} />, {
		// A TUI já trata Ctrl+C nas telas que precisam encerrar processo filho
		// antes de sair; deixar o ink matar o app na hora deixaria filho órfão.
		exitOnCtrlC: false,
	});

	await instance.waitUntilExit();
}
