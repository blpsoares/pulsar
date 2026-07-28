import { execFile } from "node:child_process";
import { platform } from "node:os";
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

export async function detectBackends(
	workingDirHasCompose: boolean,
): Promise<BackendAvailability[]> {
	const os = platform();

	const [systemd, launchd, pm2, docker] = await Promise.all([
		os === "linux" ? hasSystemdUser() : Promise.resolve(false),
		os === "darwin" ? has("launchctl", ["version"]) : Promise.resolve(false),
		has("pm2", ["--version"]),
		has("docker", ["version", "--format", "{{.Server.Version}}"]),
	]);

	return [
		{
			backend: "systemd",
			available: systemd,
			reason:
				os !== "linux"
					? `systemd não existe em ${os}`
					: systemd
						? undefined
						: "systemctl --user não respondeu (sem systemd de usuário nesta sessão)",
			fix: os === "linux" && !systemd ? "use pm2 ou docker" : undefined,
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
 * `systemctl --user` pode existir como binário e ainda assim falhar por não
 * haver um bus de sessão (container, ssh sem lingering). Testar de verdade é
 * a única forma de saber.
 */
async function hasSystemdUser(): Promise<boolean> {
	return has("systemctl", ["--user", "is-system-running"], {
		// `is-system-running` sai com código != 0 em estado "degraded", que é
		// comum e não impede nada — o que importa é o comando responder.
		acceptFailure: true,
	});
}

async function has(
	cmd: string,
	args: string[],
	opts?: { acceptFailure?: boolean },
): Promise<boolean> {
	try {
		await run(cmd, args, { timeout: 4000 });
		return true;
	} catch (err) {
		if (opts?.acceptFailure) {
			// Erro de execução (binário ausente) tem `code` string; saída != 0 tem
			// `code` numérico — só a segunda conta como "existe".
			const code = (err as { code?: unknown }).code;
			return typeof code === "number";
		}
		return false;
	}
}

/** Backend sugerido: o nativo da plataforma, se disponível. */
export function preferredBackend(
	availability: BackendAvailability[],
): Backend | null {
	const order: Backend[] =
		platform() === "darwin"
			? ["launchd", "pm2", "docker", "systemd"]
			: ["systemd", "docker", "pm2", "launchd"];

	for (const backend of order) {
		if (availability.find((a) => a.backend === backend)?.available)
			return backend;
	}
	return null;
}
