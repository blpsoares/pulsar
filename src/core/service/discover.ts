import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Backend } from "./types";

const run = promisify(execFile);

/**
 * Descobre TODOS os serviços do pulsar na máquina, em qualquer backend.
 *
 * Responde à pergunta que mais se faz numa VM: "o que está rodando agora?".
 * Antes só era possível saber consultando um serviço por vez, a partir da
 * config correspondente — inútil quando o que se quer é justamente o inverso
 * (ver o que existe e mexer nele).
 *
 * Cada supervisor é consultado do seu jeito e os parsers ficam puros e
 * separados: é onde mora a chance de erro, e é o que os testes cobrem sem
 * depender de systemd/pm2/docker instalados.
 */

export type DiscoveredService = {
	backend: Backend;
	/** nome como o supervisor o conhece */
	name: string;
	running: boolean;
	/** sobe no boot */
	enabled: boolean;
	detail?: string;
};

const PREFIX = "pulsar-";
/** launchd usa domínio reverso; os agents do pulsar começam assim. */
const LAUNCHD_PREFIX = "com.pulsar.";

export async function discoverServices(): Promise<DiscoveredService[]> {
	const results = await Promise.all([
		fromSystemd(),
		fromPm2(),
		fromDocker(),
		fromLaunchd(),
	]);

	return results
		.flat()
		.sort(
			(a, b) =>
				Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
		);
}

// ------------------------------------------------------------------ systemd

/**
 * `systemctl --user list-units --all` traz estado; `is-enabled` traz o boot.
 * Formato: NOME CARREGADO ATIVO SUB DESCRIÇÃO — as colunas podem vir com um
 * marcador (●) na frente, que o parser descarta.
 */
export function parseSystemdUnits(stdout: string): DiscoveredService[] {
	const out: DiscoveredService[] = [];

	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/^[●*x✕→\s]+/, "").trim();
		if (!line || line.startsWith("UNIT") || !line.includes(".service"))
			continue;

		const [unit, _loaded, active, sub] = line.split(/\s+/);
		if (!unit?.startsWith(PREFIX)) continue;

		out.push({
			backend: "systemd",
			name: unit.replace(/\.service$/, ""),
			running: active === "active" && sub !== "dead",
			// list-units não informa o boot; preenchido depois por is-enabled
			enabled: false,
			detail: `${active ?? "?"} (${sub ?? "?"})`,
		});
	}

	return out;
}

async function fromSystemd(): Promise<DiscoveredService[]> {
	try {
		const { stdout } = await run(
			"systemctl",
			["--user", "list-units", "--all", "--no-legend", "--plain", "pulsar-*"],
			{ timeout: 5000 },
		);
		const services = parseSystemdUnits(stdout);

		// O boot é uma pergunta por unit; são poucas, e em paralelo.
		await Promise.all(
			services.map(async (service) => {
				try {
					const { stdout: state } = await run(
						"systemctl",
						["--user", "is-enabled", `${service.name}.service`],
						{ timeout: 4000 },
					);
					service.enabled = state.trim() === "enabled";
				} catch {
					// `is-enabled` sai com código != 0 quando está disabled/static
					service.enabled = false;
				}
			}),
		);

		return services;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------- pm2

export function parsePm2List(stdout: string): DiscoveredService[] {
	try {
		const apps = JSON.parse(stdout) as {
			name?: string;
			pm2_env?: { status?: string; autorestart?: boolean };
		}[];

		return apps
			.filter((app) => String(app.name ?? "").startsWith(PREFIX))
			.map((app) => ({
				backend: "pm2" as const,
				name: String(app.name),
				running: app.pm2_env?.status === "online",
				// o pm2 restaura a lista salva no boot; autorestart é o que mantém no ar
				enabled: app.pm2_env?.autorestart !== false,
				detail: app.pm2_env?.status,
			}));
	} catch {
		return [];
	}
}

async function fromPm2(): Promise<DiscoveredService[]> {
	try {
		const { stdout } = await run("pm2", ["jlist"], { timeout: 6000 });
		return parsePm2List(stdout);
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------- docker

/** Formato pedido no `docker ps`: NOME<TAB>ESTADO<TAB>POLÍTICA_DE_RESTART. */
export function parseDockerPs(stdout: string): DiscoveredService[] {
	const out: DiscoveredService[] = [];

	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const [name, status, policy] = line.split("\t");
		if (!name?.startsWith(PREFIX)) continue;

		out.push({
			backend: "docker",
			name,
			running: (status ?? "").toLowerCase().startsWith("up"),
			enabled: policy === "unless-stopped" || policy === "always",
			detail: status,
		});
	}

	return out;
}

async function fromDocker(): Promise<DiscoveredService[]> {
	try {
		const { stdout } = await run(
			"docker",
			[
				"ps",
				"-a",
				"--filter",
				`name=${PREFIX}`,
				"--format",
				"{{.Names}}\t{{.Status}}\t{{.Labels}}",
			],
			{ timeout: 6000 },
		);
		// O formato do `ps` não expõe a política de restart; buscamos por inspect
		// só nos containers encontrados.
		const services = parseDockerPs(
			stdout
				.split("\n")
				.map((line) => {
					const [name, status] = line.split("\t");
					return name ? `${name}\t${status ?? ""}\t` : "";
				})
				.join("\n"),
		);

		await Promise.all(
			services.map(async (service) => {
				try {
					const { stdout: policy } = await run(
						"docker",
						[
							"inspect",
							"-f",
							"{{.HostConfig.RestartPolicy.Name}}",
							service.name,
						],
						{ timeout: 5000 },
					);
					const name = policy.trim();
					service.enabled = name === "unless-stopped" || name === "always";
				} catch {
					service.enabled = false;
				}
			}),
		);

		return services;
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------ launchd

export function parseLaunchdList(stdout: string): DiscoveredService[] {
	const out: DiscoveredService[] = [];

	for (const line of stdout.split("\n")) {
		const parts = line.trim().split(/\s+/);
		const label = parts[2];
		if (!label?.startsWith(LAUNCHD_PREFIX)) continue;

		const pid = parts[0];
		out.push({
			backend: "launchd",
			name: label,
			// PID "-" = carregado mas não rodando
			running: pid !== "-" && /^\d+$/.test(pid ?? ""),
			enabled: true, // estar na lista significa carregado
			detail: pid === "-" ? "carregado, parado" : `pid ${pid}`,
		});
	}

	return out;
}

async function fromLaunchd(): Promise<DiscoveredService[]> {
	try {
		const { stdout } = await run("launchctl", ["list"], { timeout: 5000 });
		return parseLaunchdList(stdout);
	} catch {
		return [];
	}
}
