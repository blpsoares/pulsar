import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { committedResources } from "../compose/committed";
import { recommendResources } from "../compose/recommend";
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
};

export function buildPlan(
	backend: Backend,
	spec: ServiceSpec,
): InstallPlan | { error: string } {
	switch (backend) {
		case "systemd":
			return systemdPlan(spec);
		case "launchd":
			return launchdPlan(spec);
		case "pm2":
			return pm2Plan(spec);
		case "docker": {
			// Os recursos saem do uso atual da máquina, descontando o que as
			// instâncias existentes já comprometeram — a mesma conta do
			// `pulsar compose up`, via a mesma função.
			const committed = committedResources();
			return dockerPlan(
				spec,
				recommendResources(
					totalmem(),
					cpus().length,
					committed.mem,
					committed.cpus,
				),
			);
		}
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

	const stepOpts = {
		cwd: spec.workingDir,
		sudo: opts?.sudo ?? "needs-password",
		ask: opts?.ask ?? (async () => false),
		onOutput: opts?.onOutput,
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

	return { plan, files: written, results, skippedPrivileged, ok };
}

export async function uninstallService(
	backend: Backend,
	spec: ServiceSpec,
): Promise<StepResult[]> {
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

	return results;
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
							args: ["bootout", `gui/${uid}/${agentLabel(spec)}`],
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

	return execStep(step, { cwd: spec.workingDir });
}

function parseProps(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

function errorText(err: unknown): string {
	const e = err as { stdout?: string; stderr?: string; message?: string };
	return (e.stderr || e.stdout || e.message || String(err)).trim();
}

function shortError(err: unknown): string {
	return errorText(err).split("\n")[0]?.slice(0, 120) ?? "";
}
