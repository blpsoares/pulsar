import { join } from "node:path";
import type { Command } from "../run/pulsarCommand";
import type { Backend } from "../service/types";

/**
 * O seguidor de log NATIVO de cada supervisor.
 *
 * A TUI não reimplementa "seguir o stdout do serviço": cada backend já guarda
 * essa saída do seu jeito (journal binário, arquivo do pm2, driver de log do
 * docker) e só a ferramenta dele sabe ler. Rodar o seguidor nativo também dá de
 * graça o histórico anterior ao momento em que a TUI abriu.
 *
 * Complementa `readLog` — o arquivo em `./logs` tem o que o winston gravou; o
 * supervisor tem o que o processo imprimiu (inclusive o crash antes do logger
 * inicializar).
 */

export type TailOptions = {
	/** diretório de trabalho do serviço (onde fica ./logs) */
	workingDir: string;
	/** label do LaunchAgent — o launchd escreve em arquivo, não em journal */
	label: string;
	/** quantas linhas de histórico trazer antes de seguir */
	lines?: number;
};

export function tailCommand(
	backend: Backend,
	name: string,
	opts: TailOptions,
): Command {
	const lines = opts.lines ?? 200;

	switch (backend) {
		case "systemd":
			// --user: a unit é de usuário (instalada sem sudo).
			return {
				cmd: "journalctl",
				args: [
					"--user",
					"-u",
					`${name}.service`,
					"-n",
					String(lines),
					"-f",
					"--no-pager",
					"-o",
					"cat",
				],
			};

		case "pm2":
			// --raw tira o prefixo do pm2; a TUI já colore por nível.
			return {
				cmd: "pm2",
				args: ["logs", name, "--lines", String(lines), "--raw"],
			};

		case "docker":
			return {
				cmd: "docker",
				args: ["logs", "-f", "--tail", String(lines), name],
			};

		case "launchd":
			// O plist manda stdout/stderr para <workingDir>/logs/<label>.out.log.
			// -F (não -f) reabre o arquivo quando o launchd rotaciona.
			return {
				cmd: "tail",
				args: [
					"-n",
					String(lines),
					"-F",
					join(opts.workingDir, "logs", `${opts.label}.out.log`),
				],
			};
	}
}
