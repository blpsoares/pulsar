import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTerminal } from "../tty/handoff";
import { execStep, type StepResult } from "./execStep";
import type { ServiceStep } from "./types";

const run = promisify(execFile);

/**
 * Sudo resolvido DURANTE a instalação, não relatado como pendência no fim.
 *
 * O comportamento anterior era `if (step.privileged) continue;`: o passo era
 * pulado em silêncio e, no fim de tudo, a tela informava que não tinha dado
 * porque precisava de sudo. A informação existia desde antes de começar e era
 * guardada até o pior momento possível. Aqui ela é usada no começo: se `sudo -n`
 * passa, roda direto; se não passa, pergunta na hora, mostrando o comando
 * literal — e "não" é uma resposta válida que não faz a instalação falhar.
 */

export type SudoMode = "passwordless" | "needs-password" | "unavailable";

/** `sudo -n true` sai 0 só quando não haveria prompt de senha. */
export async function detectSudo(
	probe: () => Promise<boolean> = async () => {
		try {
			await run("sudo", ["-n", "true"], { timeout: 4000 });
			return true;
		} catch {
			return false;
		}
	},
): Promise<SudoMode> {
	return (await probe()) ? "passwordless" : "needs-password";
}

/** O que `runPrivilegedStep` decide fazer com um passo, a partir do `SudoMode`. */
export type PrivilegedDecision = "run" | "ask" | "skip";

export type AskCallback = (step: ServiceStep) => Promise<boolean>;

/**
 * Devolve `null` quando o usuário escolheu pular — que é diferente de falhar.
 */
export async function runPrivilegedStep(
	step: ServiceStep,
	opts: {
		cwd: string;
		sudo: SudoMode;
		ask: AskCallback;
		onOutput?: (line: string) => void;
	},
): Promise<StepResult | null> {
	if (opts.sudo === "unavailable") return null;

	if (opts.sudo === "passwordless")
		return execStep(step, { cwd: opts.cwd, onOutput: opts.onOutput });

	if (!(await opts.ask(step))) return null;

	// O sudo precisa do terminal de verdade para desenhar o prompt de senha e
	// ler sem eco. `withTerminal` sai do alternate screen e restaura em finally;
	// `interactive` é a outra metade — sem ela o filho nasce com stdin fechado e
	// o sudo morre com "a terminal is required to read the password" num
	// terminal que a TUI acabou de largar. Só ESTE ramo é interativo: o
	// `passwordless` acima não abre prompt nenhum e continua capturando a saída.
	return withTerminal(() =>
		execStep(step, {
			cwd: opts.cwd,
			onOutput: opts.onOutput,
			interactive: true,
		}),
	);
}
