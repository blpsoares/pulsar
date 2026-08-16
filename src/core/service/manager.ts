import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { committedResources } from "../compose/committed";
import { type ResourceRec, recommendResources } from "../compose/recommend";
import {
	composePath,
	dockerPlan,
	dockerServiceName,
	dockerUninstallSteps,
} from "./dockerService";
import { execStep, type StepResult } from "./execStep";
import {
	agentLabel,
	agentPath,
	guiTarget,
	launchdPlan,
	launchdUninstallSteps,
} from "./launchd";
import { ecosystemPath, pm2Plan, pm2UninstallSteps } from "./pm2";
import {
	type AskCallback,
	runPrivilegedStep,
	type SudoMode,
} from "./privileged";
import { systemdPlan, systemdUninstallSteps, unitPath } from "./systemd";
import {
	type Backend,
	type InstallPlan,
	type ServiceSpec,
	type ServiceStatus,
	type ServiceStep,
	serviceName,
} from "./types";

export type { StepResult } from "./execStep";
export { execStep } from "./execStep";

const run = promisify(execFile);

/**
 * Executor: pega o plano de um backend, grava os arquivos e roda os passos.
 *
 * Regras que valem para todos os backends:
 *
 * - Passo `privileged` é resolvido NA HORA via `runPrivilegedStep`
 *   (`./privileged.ts`): sem senha, roda direto; com senha, pergunta antes de
 *   rodar, mostrando o comando literal. Recusar não é falha — o passo entra em
 *   `skippedPrivileged` e a instalação segue.
 * - Passo `optional` que falha não aborta a instalação — são os "pare o que
 *   talvez não exista" que precedem o start.
 * - `plan.manualSteps` RODA TAMBÉM (não é só texto para o usuário copiar),
 *   sempre DEPOIS de `plan.steps` — só faz sentido tentar o que exige sudo
 *   depois que o serviço já foi instalado e iniciado. Um passo com
 *   `fallbackFor: <id>` só roda se o passo automático de `id` correspondente
 *   tiver falhado (ou nem rodado) — sem isso, o par "tenta sem sudo" +
 *   "refaz com sudo" pediria senha à toa mesmo quando o automático já
 *   resolveu (ex.: `loginctl enable-linger` do systemd, que costuma
 *   funcionar sem sudo via polkit). Uma falha ou recusa em `manualSteps`
 *   nunca reabre `ok`: o serviço já está no ar nesse ponto, só o boot
 *   automático é que fica pendente.
 */

export type InstallResult = {
	plan: InstallPlan;
	files: string[];
	results: StepResult[];
	/** passos com sudo que o usuário optou por não rodar agora */
	skippedPrivileged: ServiceStep[];
	ok: boolean;
	/** uma linha explicando a falha e o que fazer — vazia quando deu certo */
	error?: string;
};

/**
 * Recursos recomendados para uma instância nova nesta máquina.
 *
 * A mesma conta do `pulsar compose up`, via a mesma função: parte do orçamento
 * da VM e SUBTRAI o que as instâncias existentes já comprometeram. Exportada
 * para que a tela e o `pulsar start` possam MOSTRAR o número antes de aplicar
 * — e oferecer o ajuste manual.
 */
export function recommendedResources(): ResourceRec {
	const committed = committedResources();
	return recommendResources(
		totalmem(),
		cpus().length,
		committed.mem,
		committed.cpus,
	);
}

export function buildPlan(
	backend: Backend,
	spec: ServiceSpec,
	/** cerca de RAM/CPU escolhida (docker); omitido = a recomendada */
	resources?: ResourceRec,
): InstallPlan | { error: string } {
	switch (backend) {
		case "systemd":
			return systemdPlan(spec);
		case "launchd":
			return launchdPlan(spec);
		case "pm2":
			return pm2Plan(spec);
		case "docker":
			return dockerPlan(spec, resources ?? recommendedResources());
	}
}

export async function installService(
	plan: InstallPlan,
	spec: ServiceSpec,
	opts?: {
		onOutput?: (line: string) => void;
		sudo?: SudoMode;
		ask?: AskCallback;
	},
): Promise<InstallResult> {
	const written: string[] = [];

	for (const file of plan.files) {
		mkdirSync(dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
		written.push(file.path);
	}

	// launchd e pm2 escrevem log direto em ./logs; se a pasta não existe, o
	// serviço falha ao iniciar com um erro pouco óbvio.
	mkdirSync(join(spec.workingDir, "logs"), { recursive: true });

	const results: StepResult[] = [];
	const skippedPrivileged: ServiceStep[] = [];
	// Por `id`, para os `fallbackFor` de `manualSteps` saberem se o passo
	// automático correspondente já resolveu sozinho.
	const resultsById = new Map<string, StepResult>();
	let ok = true;
	let error: string | undefined;

	const stepOpts = {
		cwd: spec.workingDir,
		sudo: opts?.sudo ?? "needs-password",
		ask: opts?.ask ?? (async () => false),
		onOutput: opts?.onOutput,
		// O `execStep` preenche `advice`/`raw` no resultado; quem sabe traduzir a
		// falha é aqui, que conhece o backend do plano.
		advise: (raw: string) => adviseFailure(plan.backend, raw),
	};

	const runOne = (step: ServiceStep) =>
		step.privileged
			? runPrivilegedStep(step, stepOpts)
			: execStep(step, stepOpts);

	for (const step of plan.steps) {
		const result = await runOne(step);

		// Pular um passo com sudo é uma escolha, não uma falha: o serviço sobe
		// mesmo assim e só o boot fica pendente.
		if (result === null) {
			skippedPrivileged.push(step);
			continue;
		}

		results.push(result);
		if (step.id) resultsById.set(step.id, result);

		if (!result.ok && !step.optional) {
			ok = false;
			error = stepFailure(step, result.raw ?? result.output, result.advice);
			// Parar no primeiro passo essencial que falha: seguir adiante
			// deixaria um serviço meio instalado, pior que nenhum.
			break;
		}
	}

	// manualSteps só depois do serviço de pé — e só quando `plan.steps` não
	// travou num passo essencial (ver comentário no topo do arquivo).
	if (ok) {
		for (const step of plan.manualSteps) {
			if (step.fallbackFor && resultsById.get(step.fallbackFor)?.ok) continue;

			const result = await runOne(step);

			if (result === null) {
				skippedPrivileged.push(step);
				continue;
			}

			results.push(result);
			if (step.id) resultsById.set(step.id, result);
			// Falha aqui não derruba `ok`: são passos de complemento (boot),
			// não do serviço em si — que já está rodando neste ponto.
		}
	}

	return { plan, files: written, results, skippedPrivileged, ok, error };
}

/**
 * Mensagem de falha ACIONÁVEL: comando + causa + saída sugerida, numa linha só.
 *
 * O stderr cru (`Failed to connect to bus: No medium found`) diz o que o
 * systemd sentiu, não o que o usuário deve fazer — e a tela mostra só a
 * primeira linha do output, então a saída sugerida tem que caber ali.
 */
export function stepFailure(
	step: ServiceStep,
	output: string,
	advice?: string,
): string {
	const cause = output.split("\n")[0]?.trim() || "sem saída do comando";
	const cmd = `${step.cmd} ${step.args.join(" ")}`.trim();
	return advice ? `${cmd} — ${cause} · ${advice}` : `${cmd} — ${cause}`;
}

/**
 * Traduz as falhas que já vimos em campo para a ação que resolve. Sempre
 * termina propondo TROCAR DE BACKEND: quem está numa tela de instalação quer
 * o serviço no ar, não um diagnóstico do systemd.
 */
export function adviseFailure(
	backend: Backend,
	output: string,
): string | undefined {
	const text = output.toLowerCase();

	if (backend === "systemd") {
		if (
			/failed to connect to bus|no medium found|failed to get d-?bus/.test(text)
		)
			return "esta sessão não tem bus de usuário (WSL/container): troque o backend para docker ou pm2";
		if (text.includes("interactive authentication required"))
			return "o systemd pediu autenticação: troque para docker ou pm2, que não dependem de polkit";
	}

	if (backend === "pm2" && /not found|enoent/.test(text))
		return "instale o pm2 (bun add -g pm2) ou troque o backend para docker";

	if (
		backend === "docker" &&
		/cannot connect to the docker daemon|permission denied|is the docker daemon running/.test(
			text,
		)
	)
		return "o daemon do Docker não respondeu: suba o Docker ou troque o backend para pm2";

	return "se o backend não funciona nesta máquina, troque na tela (tab) por um que esteja disponível";
}

/**
 * Desinstalar tem que DIZER se deu certo — e "os passos saíram com 0" não
 * responde isso.
 *
 * Todo passo de remoção é `optional` de propósito (parar o que talvez nem
 * exista não pode abortar nada), então o resultado dos passos nunca reprova
 * ninguém. Quem responde de verdade é o supervisor, perguntado DEPOIS: se o
 * serviço continua instalado ou rodando, a remoção falhou. Isso importa porque
 * quem chama usa a resposta para decidir se pode instalar outro no lugar — e
 * dois `sync` na mesma config brigam pelo resume token global em `__sync` e
 * duplicam escrita no destino.
 */
export type UninstallResult = {
	ok: boolean;
	results: StepResult[];
	/** o que o supervisor respondeu depois da remoção (null: não checado) */
	status: ServiceStatus | null;
};

export async function uninstallService(
	backend: Backend,
	spec: ServiceSpec,
	opts?: {
		/** injetável para o teste não precisar de supervisor instalado */
		verify?: (backend: Backend, spec: ServiceSpec) => Promise<ServiceStatus>;
	},
): Promise<UninstallResult> {
	const name = serviceName(spec);
	const steps =
		backend === "systemd"
			? systemdUninstallSteps(name)
			: backend === "launchd"
				? launchdUninstallSteps(agentLabel(spec))
				: backend === "pm2"
					? pm2UninstallSteps(name)
					: dockerUninstallSteps(spec);

	const results: StepResult[] = [];
	// `execStep` (e não `execFile`): a saída completa da falha fica em `raw`,
	// que é o que a tela mostra ao abrir o passo.
	for (const step of steps)
		results.push(await execStep(step, { cwd: spec.workingDir }));

	// Remove os arquivos gerados só depois de o serviço estar parado — apagar a
	// unit com o serviço no ar deixa um processo sem dono.
	for (const path of generatedFiles(backend, spec)) {
		try {
			rmSync(path, { force: true });
		} catch {
			// arquivo já removido à mão: nada a fazer
		}
	}

	if (backend === "systemd") {
		await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
	}

	const status = await (opts?.verify ?? serviceStatus)(backend, spec);
	return { ok: !status.installed && !status.running, results, status };
}

function generatedFiles(backend: Backend, spec: ServiceSpec): string[] {
	switch (backend) {
		case "systemd":
			return [unitPath(spec)];
		case "launchd":
			return [agentPath(spec)];
		case "pm2":
			return [ecosystemPath(spec)];
		case "docker":
			return [composePath(spec)];
	}
}

export async function serviceStatus(
	backend: Backend,
	spec: ServiceSpec,
): Promise<ServiceStatus> {
	const name = serviceName(spec);
	const base = {
		backend,
		name,
		installed: false,
		running: false,
		enabled: false,
	};

	try {
		switch (backend) {
			case "systemd": {
				const { stdout } = await run("systemctl", [
					"--user",
					"show",
					`${name}.service`,
					"--property=ActiveState",
					"--property=UnitFileState",
					"--property=SubState",
				]);
				const props = parseProps(stdout);
				return {
					...base,
					installed: Boolean(props.UnitFileState && props.UnitFileState !== ""),
					running: props.ActiveState === "active",
					enabled: props.UnitFileState === "enabled",
					detail: `${props.ActiveState ?? "?"} (${props.SubState ?? "?"})`,
				};
			}
			case "launchd": {
				const label = agentLabel(spec);
				const { stdout } = await run("launchctl", ["list"]);
				const line = stdout.split("\n").find((l) => l.trim().endsWith(label));
				// Colunas: PID  ExitStatus  Label. PID "-" = carregado, não rodando.
				const pid = line?.trim().split(/\s+/)[0];
				return {
					...base,
					installed: Boolean(line),
					running: Boolean(pid && pid !== "-"),
					enabled: Boolean(line),
					detail: line?.trim(),
				};
			}
			case "pm2": {
				const { stdout } = await run("pm2", ["jlist"]);
				const apps = JSON.parse(stdout) as {
					name: string;
					pm2_env?: { status?: string };
				}[];
				const app = apps.find((a) => a.name === name);
				return {
					...base,
					installed: Boolean(app),
					running: app?.pm2_env?.status === "online",
					enabled: Boolean(app),
					detail: app?.pm2_env?.status,
				};
			}
			case "docker": {
				const container = dockerServiceName(spec);
				const { stdout } = await run("docker", [
					"inspect",
					"-f",
					"{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}",
					container,
				]);
				const [status, policy] = stdout.trim().split(/\s+/);
				return {
					backend,
					name: container,
					installed: true,
					running: status === "running",
					enabled: policy === "unless-stopped" || policy === "always",
					detail: `${status} · restart=${policy}`,
				};
			}
		}
	} catch (err) {
		// Serviço inexistente é o caminho normal (ainda não instalado), não um
		// erro que valha exibir em vermelho.
		return { ...base, detail: shortError(err) };
	}
}

/** start/stop de um serviço já instalado. */
export async function controlService(
	backend: Backend,
	spec: ServiceSpec,
	action: "start" | "stop" | "restart",
): Promise<StepResult> {
	const name = serviceName(spec);
	const uid = process.getuid?.() ?? 501;

	const step: ServiceStep = (() => {
		switch (backend) {
			case "systemd":
				return {
					cmd: "systemctl",
					args: ["--user", action, `${name}.service`],
					why: `${action} do serviço`,
				};
			case "launchd":
				return action === "stop"
					? {
							cmd: "launchctl",
							args: ["bootout", guiTarget(agentLabel(spec), uid)],
							why: "descarrega o agent",
						}
					: {
							cmd: "launchctl",
							args: ["bootstrap", `gui/${uid}`, agentPath(spec)],
							why: "carrega o agent",
						};
			case "pm2":
				return { cmd: "pm2", args: [action, name], why: `${action} no pm2` };
			case "docker":
				return {
					cmd: "docker",
					args: [action, dockerServiceName(spec)],
					why: `${action} do container`,
				};
		}
	})();

	return execStep(step, {
		cwd: spec.workingDir,
		advise: (raw: string) => adviseFailure(backend, raw),
	});
}

function parseProps(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

/**
 * Junta stderr E stdout, nessa ordem, em vez de escolher um.
 *
 * O `docker compose` escreve o progresso do build no stderr e a causa da falha
 * pode sair em qualquer um dos dois; ficar só com o stderr (ou só com o
 * primeiro não-vazio) descartava justamente a linha que explica o erro.
 */
function errorText(err: unknown): string {
	const e = err as { stdout?: string; stderr?: string; message?: string };
	const partes = [e.stderr, e.stdout]
		.map((p) => (p ?? "").trim())
		.filter(Boolean);
	if (partes.length === 0) return (e.message || String(err)).trim();
	return partes.join("\n");
}

function shortError(err: unknown): string {
	return errorText(err).split("\n")[0]?.slice(0, 120) ?? "";
}
