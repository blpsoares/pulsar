import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { committedResources } from "../compose/committed";
import { recommendResources } from "../compose/recommend";
import { LineBuffer } from "../run/logLines";
import {
	composePath,
	dockerPlan,
	dockerServiceName,
	dockerUninstallSteps,
} from "./dockerService";
import {
	agentLabel,
	agentPath,
	launchdPlan,
	launchdUninstallSteps,
} from "./launchd";
import { ecosystemPath, pm2Plan, pm2UninstallSteps } from "./pm2";
import { systemdPlan, systemdUninstallSteps, unitPath } from "./systemd";
import {
	type Backend,
	type InstallPlan,
	type ServiceSpec,
	type ServiceStatus,
	type ServiceStep,
	serviceName,
} from "./types";

const run = promisify(execFile);

/**
 * Executor: pega o plano de um backend, grava os arquivos e roda os passos.
 *
 * Duas regras que valem para todos os backends:
 *
 * - Passo `privileged` NUNCA é executado aqui. A TUI mostra o comando para o
 *   usuário rodar. Um menu que dispara sudo sozinho é exatamente o tipo de
 *   coisa que ninguém consegue auditar depois.
 * - Passo `optional` que falha não aborta a instalação — são os "pare o que
 *   talvez não exista" que precedem o start.
 */

export type StepResult = {
	step: ServiceStep;
	ok: boolean;
	output: string;
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
	opts: { cwd: string; onOutput?: (line: string) => void },
): Promise<StepResult> {
	return new Promise((resolve) => {
		const buffer = new LineBuffer(STEP_OUTPUT_LINES);
		const child = spawn(step.cmd, step.args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
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
			resolve({ step, ok, output });
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

export type InstallResult = {
	plan: InstallPlan;
	files: string[];
	results: StepResult[];
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
	onOutput?: (line: string) => void,
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
	let ok = true;

	for (const step of plan.steps) {
		if (step.privileged) continue;

		const result = await execStep(step, { cwd: spec.workingDir, onOutput });
		results.push(result);

		if (!result.ok && !step.optional) {
			ok = false;
			// Parar no primeiro passo essencial que falha: seguir adiante
			// deixaria um serviço meio instalado, pior que nenhum.
			break;
		}
	}

	return { plan, files: written, results, ok };
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
