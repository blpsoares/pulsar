import { spawn } from "node:child_process";
import { LineBuffer } from "../run/logLines";
import type { ServiceStep } from "./types";

export type StepResult = {
	step: ServiceStep;
	ok: boolean;
	output: string;
	/** o que fazer a respeito, quando dá para saber (só em falha) */
	advice?: string;
	/**
	 * A saída COMPLETA do comando que falhou, sem resumir.
	 *
	 * `output` é o que cabe na lista de passos. Só que o erro de verdade do
	 * `docker compose` (ou do `systemctl`) quase nunca está na primeira linha —
	 * vem depois, no fim do stderr. Guardar só o resumo deixava a tela dizendo
	 * "parou num passo obrigatório" sem NENHUMA pista do motivo, que é a pior
	 * combinação possível: o usuário sabe que quebrou e não tem como descobrir
	 * por quê sem sair da TUI e repetir o comando à mão.
	 */
	raw?: string;
};

/** Teto padrão de um passo — vale para tudo que não declara o seu. */
const STEP_TIMEOUT_MS = 120_000;

/** Quantas linhas da saída ficam guardadas para o relatório do passo. */
const STEP_OUTPUT_LINES = 200;

/**
 * Executa um passo com a saída em STREAMING.
 *
 * Não é `execFile`: ele acumula a saída inteira num buffer de 1 MB e mata o
 * processo quando estoura. O `docker compose up --build` é justamente o passo
 * que cospe muita saída e demora minutos — as duas coisas que o `execFile`
 * pune. Aqui a saída vai para um anel de N linhas (a cauda é o que interessa
 * quando algo falha) e cada linha é repassada na hora, para a tela poder
 * mostrar que ainda está vivo em vez de congelar sem explicação.
 */
export function execStep(
	step: ServiceStep,
	opts: {
		cwd: string;
		onOutput?: (line: string) => void;
		/**
		 * Entrega o TERMINAL ao filho (`stdio: "inherit"`), em vez de capturar a
		 * saída. É o que o `sudo` precisa para desenhar o prompt e ler a senha sem
		 * eco: com `["ignore","pipe","pipe"]` ele não tem stdin nem TTY e sai na
		 * hora com "a terminal is required to read the password".
		 *
		 * O preço é não haver saída capturada — `output` fica vazio. Não é uma
		 * limitação contornável: o que dá o prompt ao usuário é justamente o filho
		 * escrever DIRETO no terminal, e não em um pipe nosso. Quem chama assim já
		 * mostrou o comando literal ao usuário antes (`SudoConfirm`), e a saída
		 * aparece na tela real durante o handoff.
		 */
		interactive?: boolean;
		/**
		 * Traduz a saída crua de uma falha na AÇÃO que resolve. Vem de fora
		 * (`manager.adviseFailure`, que conhece o backend) porque o `execStep` não
		 * sabe qual supervisor está sendo instalado — e importar o manager aqui
		 * refaria o ciclo de import que tirou o `StepResult` de lá.
		 */
		advise?: (raw: string) => string | undefined;
	},
): Promise<StepResult> {
	return new Promise((resolve) => {
		const buffer = new LineBuffer(STEP_OUTPUT_LINES);
		const child = spawn(step.cmd, step.args, {
			cwd: opts.cwd,
			stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
		}, step.timeoutMs ?? STEP_TIMEOUT_MS);

		const collect = (chunk: Buffer | string) => {
			buffer.push(String(chunk));
			// A tela mostra só a linha mais recente: é sinal de vida, não um log.
			const last = buffer.all().at(-1);
			if (last) opts.onOutput?.(last);
		};

		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		const finish = (ok: boolean, extra?: string) => {
			clearTimeout(timer);
			const output = [buffer.all().join("\n"), extra]
				.filter(Boolean)
				.join("\n")
				.trim();
			if (ok) {
				resolve({ step, ok, output });
				return;
			}
			// Em falha o texto inteiro é preservado em `raw` (é o que o
			// `pulsar start` imprime e o que a tela mostra ao abrir o passo).
			const raw = output;
			resolve({ step, ok, output, raw, advice: opts.advise?.(raw) });
		};

		child.on("error", (err) => finish(false, err.message));
		child.on("close", (code) => {
			if (timedOut)
				finish(
					false,
					`o passo passou de ${Math.round(
						(step.timeoutMs ?? STEP_TIMEOUT_MS) / 1000,
					)}s e foi interrompido`,
				);
			else
				finish(code === 0, code === 0 ? undefined : `saiu com código ${code}`);
		});
	});
}
