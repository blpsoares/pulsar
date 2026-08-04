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
	/** o que fazer a respeito, quando dá para saber (só em falha) */
	advice?: string;
	/**
	 * A saída COMPLETA do comando que falhou, sem resumir.
	 *
	 * `output` é uma linha, porque é o que cabe na lista de passos. Só que o
	 * erro de verdade do `docker compose` (ou do `systemctl`) quase nunca está
	 * na primeira linha — vem depois, no fim do stderr. Guardar só o resumo
	 * deixava a tela dizendo "parou num passo obrigatório" sem NENHUMA pista do
	 * motivo, que é a pior combinação possível: o usuário sabe que quebrou e
	 * não tem como descobrir por quê sem sair da TUI e repetir o comando à mão.
	 */
	raw?: string;
};

export type InstallResult = {
	plan: InstallPlan;
	files: string[];
	results: StepResult[];
	ok: boolean;
	/** uma linha explicando a falha e o que fazer — vazia quando deu certo */
	error?: string;
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
	let error: string | undefined;

	for (const step of plan.steps) {
		if (step.privileged) continue;

		try {
			const { stdout, stderr } = await run(step.cmd, step.args, {
				cwd: spec.workingDir,
				timeout: 120_000,
			});
			results.push({ step, ok: true, output: (stdout + stderr).trim() });
		} catch (err) {
			const raw = errorText(err);
			const advice = adviseFailure(plan.backend, raw);
			results.push({
				step,
				ok: false,
				output: stepFailure(step, raw, advice),
				advice,
				raw,
			});
			if (!step.optional) {
				ok = false;
				error = stepFailure(step, raw, advice);
				// Parar no primeiro passo essencial que falha: seguir adiante
				// deixaria um serviço meio instalado, pior que nenhum.
				break;
			}
		}
	}

	return { plan, files: written, results, ok, error };
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
	for (const step of steps) {
		try {
			const { stdout, stderr } = await run(step.cmd, step.args, {
				cwd: spec.workingDir,
				timeout: 120_000,
			});
			results.push({ step, ok: true, output: (stdout + stderr).trim() });
		} catch (err) {
			const raw = errorText(err);
			results.push({ step, ok: false, output: raw, raw });
		}
	}

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

	try {
		const { stdout, stderr } = await run(step.cmd, step.args, {
			cwd: spec.workingDir,
			timeout: 120_000,
		});
		return { step, ok: true, output: (stdout + stderr).trim() };
	} catch (err) {
		const raw = errorText(err);
		const advice = adviseFailure(backend, raw);
		return {
			step,
			ok: false,
			output: stepFailure(step, raw, advice),
			advice,
			raw,
		};
	}
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
