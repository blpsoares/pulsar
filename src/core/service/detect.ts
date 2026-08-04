import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Backend } from "./types";

const run = promisify(execFile);

/**
 * O que esta máquina realmente consegue fazer.
 *
 * A TUI não oferece um backend que não vai funcionar aqui — oferecer systemd
 * num Mac ou pm2 sem o pm2 instalado empurra o usuário para um erro que ele
 * não tem como resolver a partir da tela. Cada backend é testado com um
 * comando barato, não deduzido do sistema operacional.
 */

export type BackendAvailability = {
	backend: Backend;
	available: boolean;
	/** por que não dá, quando não dá */
	reason?: string;
	/** como resolver */
	fix?: string;
};

/**
 * Evidências brutas sobre o systemd de usuário. Separadas do julgamento porque
 * o julgamento é a parte que erra — e a parte que precisa de teste.
 */
export type SystemdProbe = {
	/** `/run/systemd/system` existe: systemd é o init desta máquina */
	systemAsInit: boolean;
	/** o socket do bus de usuário existe ($XDG_RUNTIME_DIR/bus ou /run/user/<uid>/bus) */
	userBusSocket: boolean;
	/**
	 * Saída de `systemctl --user is-system-running`. `null` = o binário nem
	 * existe (ENOENT/timeout) — diferente de existir e responder com erro.
	 */
	cli: { ok: boolean; stdout: string; stderr: string } | null;
};

export type SystemdVerdict = {
	available: boolean;
	reason?: string;
	fix?: string;
};

/**
 * Frases com que o systemctl anuncia "existe o binário, mas não existe bus de
 * usuário nesta sessão". É o caso do WSL2 sem systemd, de container e de ssh
 * sem lingering. Todas saem com código de saída NUMÉRICO — por isso o código
 * de saída nunca serviu como discriminante e o sinal tem que vir do stderr.
 */
const NO_BUS = /failed to connect to bus|no medium found|failed to get d-?bus/i;

/**
 * Estados que o `is-system-running` imprime quando há bus de verdade.
 * `degraded` (alguma unit falhou) e `starting` saem com código != 0 e são
 * perfeitamente utilizáveis — daí aceitarmos a saída, não o código.
 */
const LIVE_STATES = new Set([
	"running",
	"degraded",
	"starting",
	"stopping",
	"maintenance",
	"initializing",
	"offline",
]);

/**
 * O julgamento, puro. Só declara systemd de usuário disponível quando as três
 * evidências batem: systemd é o init, o socket do bus existe, e o próprio
 * systemctl respondeu com um estado em vez de reclamar do bus.
 */
export function judgeSystemdUser(probe: SystemdProbe): SystemdVerdict {
	const useOther = "use docker ou pm2 para rodar em background";

	if (!probe.cli)
		return {
			available: false,
			reason: "systemctl não está no PATH desta máquina",
			fix: useOther,
		};

	if (!probe.systemAsInit)
		return {
			available: false,
			reason:
				"systemd não é o init desta máquina (/run/systemd/system não existe) — típico de WSL/container",
			fix: useOther,
		};

	const stderr = probe.cli.stderr ?? "";
	if (NO_BUS.test(stderr))
		return {
			available: false,
			reason: `systemd de usuário sem bus nesta sessão (típico de WSL/container): ${firstLine(stderr)}`,
			fix: useOther,
		};

	if (!probe.userBusSocket)
		return {
			available: false,
			reason:
				"o socket do bus de usuário não existe ($XDG_RUNTIME_DIR/bus) — sem ele 'systemctl --user' não fala com nada",
			fix: useOther,
		};

	const state = probe.cli.stdout.trim().split("\n")[0]?.trim() ?? "";
	if (!LIVE_STATES.has(state))
		return {
			available: false,
			reason: `systemctl --user respondeu algo que não é um estado do systemd (${state || "saída vazia"})`,
			fix: useOther,
		};

	return { available: true };
}

/** Coleta as evidências de verdade nesta máquina. */
export async function probeSystemdUser(): Promise<SystemdProbe> {
	const cli = await capture("systemctl", ["--user", "is-system-running"]);
	return {
		systemAsInit: existsSync("/run/systemd/system"),
		userBusSocket: existsSync(userBusPath()),
		cli,
	};
}

function userBusPath(): string {
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg) return join(xdg, "bus");
	return `/run/user/${process.getuid?.() ?? 0}/bus`;
}

export type DetectDeps = {
	/** injetável nos testes: evita depender do systemd da máquina que roda o test */
	systemdProbe?: () => Promise<SystemdProbe>;
	/** sistema operacional, para testar o caminho de outra plataforma */
	os?: NodeJS.Platform;
};

export async function detectBackends(
	workingDirHasCompose: boolean,
	deps: DetectDeps = {},
): Promise<BackendAvailability[]> {
	const os = deps.os ?? platform();

	const [systemd, launchd, pm2, docker] = await Promise.all([
		os === "linux"
			? (deps.systemdProbe ?? probeSystemdUser)().then(judgeSystemdUser)
			: Promise.resolve<SystemdVerdict>({
					available: false,
					reason: `systemd não existe em ${os}`,
				}),
		os === "darwin" ? has("launchctl", ["version"]) : Promise.resolve(false),
		has("pm2", ["--version"]),
		has("docker", ["version", "--format", "{{.Server.Version}}"]),
	]);

	return [
		{
			backend: "systemd",
			available: systemd.available,
			reason: systemd.reason,
			fix: systemd.fix,
		},
		{
			backend: "launchd",
			available: launchd,
			reason:
				os !== "darwin"
					? `launchd é exclusivo do macOS (aqui é ${os})`
					: undefined,
		},
		{
			backend: "pm2",
			available: pm2,
			reason: pm2 ? undefined : "pm2 não está no PATH",
			fix: pm2 ? undefined : "bun add -g pm2  (ou npm i -g pm2)",
		},
		{
			backend: "docker",
			available: docker && workingDirHasCompose,
			reason: !docker
				? "docker não está no PATH ou o daemon não responde"
				: workingDirHasCompose
					? undefined
					: "docker-compose-limit.yml não existe nesta pasta",
			fix:
				docker && !workingDirHasCompose
					? "rode a TUI na raiz do projeto, onde está o docker-compose-limit.yml"
					: undefined,
		},
	];
}

/**
 * Roda o comando e devolve stdout E stderr mesmo quando ele sai com erro — a
 * mensagem que importa (`Failed to connect to bus`) vive no stderr de uma
 * execução malsucedida, e jogá-la fora foi exatamente o bug que fazia a TUI
 * oferecer systemd numa máquina sem bus.
 */
async function capture(
	cmd: string,
	args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string } | null> {
	try {
		const { stdout, stderr } = await run(cmd, args, { timeout: 4000 });
		return { ok: true, stdout, stderr };
	} catch (err) {
		const e = err as { code?: unknown; stdout?: string; stderr?: string };
		// `code` string (ENOENT) = binário ausente; numérico = rodou e saiu != 0.
		if (typeof e.code !== "number") return null;
		return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

async function has(cmd: string, args: string[]): Promise<boolean> {
	try {
		await run(cmd, args, { timeout: 4000 });
		return true;
	} catch {
		return false;
	}
}

function firstLine(value: string): string {
	return value.trim().split("\n")[0]?.trim().slice(0, 120) ?? "";
}

/**
 * Backend sugerido: o nativo da plataforma, se disponível.
 *
 * A ordem só funciona porque a disponibilidade agora é honesta: numa máquina
 * WSL o systemd cai fora na detecção e o preferido vira docker (ou pm2), em
 * vez de a TUI escolher systemd e quebrar no primeiro `daemon-reload`.
 */
export function preferredBackend(
	availability: BackendAvailability[],
	os: NodeJS.Platform = platform(),
): Backend | null {
	const order: Backend[] =
		os === "darwin"
			? ["launchd", "pm2", "docker", "systemd"]
			: ["systemd", "docker", "pm2", "launchd"];

	for (const backend of order) {
		if (availability.find((a) => a.backend === backend)?.available)
			return backend;
	}
	return null;
}
