import type { ResourceRec } from "../compose/recommend";
import type { RunMode } from "../run/pulsarCommand";

/**
 * Contrato comum aos quatro jeitos de rodar o pulsar em background.
 *
 * Cada backend (systemd, launchd, pm2, docker) recebe a MESMA descrição de
 * serviço e devolve os arquivos e comandos que materializam aquilo. Manter a
 * descrição única evita o problema clássico: o serviço do systemd apontando
 * para um caminho e o do launchd para outro, e ninguém percebe até trocar de
 * máquina.
 */

export type Backend = "systemd" | "launchd" | "pm2" | "docker";

export type ServiceSpec = {
	/** sufixo do nome do serviço: pulsar-<name> */
	name: string;
	mode: RunMode;
	/** caminho ABSOLUTO do yml — serviço não herda o diretório do shell */
	configPath: string;
	/** diretório de trabalho (onde ficam ./logs e os filterFile relativos) */
	workingDir: string;
	/** iniciar junto com o sistema */
	autostart: boolean;
	/** argumentos extras do comando (ex.: --verbose) */
	extraArgs?: string[];
};

/** Um arquivo que o backend precisa gravar para o serviço existir. */
export type ServiceFile = {
	path: string;
	content: string;
	mode?: number;
};

/** Um comando a executar, com o porquê — a TUI mostra os dois antes de rodar. */
export type ServiceStep = {
	cmd: string;
	args: string[];
	/** explicação em uma linha, exibida ao usuário */
	why: string;
	/** falha aceitável (ex.: parar um serviço que ainda não existe) */
	optional?: boolean;
	/** precisa de sudo — a TUI NUNCA roda isso sozinha, só mostra */
	privileged?: boolean;
};

export type InstallPlan = {
	backend: Backend;
	serviceName: string;
	files: ServiceFile[];
	steps: ServiceStep[];
	/** comandos que o usuário precisa rodar à mão (exigem sudo) */
	manualSteps: ServiceStep[];
	/** avisos sobre limitações do backend nesta máquina */
	notes: string[];
	/**
	 * Cerca de RAM/CPU aplicada — só o docker tem (é ele que usa cgroups).
	 *
	 * Fica NO PLANO, e não escondida dentro de quem gera o compose, porque o
	 * plano é o que a tela e o `pulsar start` mostram antes de executar: sem
	 * isso o pulsar decidia sozinho o teto de memória da máquina e ninguém
	 * ficava sabendo — nem para conferir, nem para discordar.
	 */
	resources?: ResourceRec;
};

export type ServiceStatus = {
	backend: Backend;
	name: string;
	/** o serviço existe (instalado), mesmo que parado */
	installed: boolean;
	running: boolean;
	/** habilitado para subir no boot */
	enabled: boolean;
	detail?: string;
};

/** `pulsar-<name>` é o prefixo comum a todos os backends. */
export function serviceName(spec: Pick<ServiceSpec, "name">): string {
	return `pulsar-${slug(spec.name)}`;
}

export function slug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/\.ya?ml$/i, "")
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "pulsar"
	);
}
