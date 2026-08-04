import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, join, relative } from "node:path";
import { buildInstanceCompose } from "../compose/buildCompose";
import type { ResourceRec } from "../compose/recommend";
import { type InstallPlan, type ServiceSpec, serviceName, slug } from "./types";

/**
 * Docker — o caminho que já existia no pulsar (`docker-compose-limit.yml` +
 * `pulsar compose up`), agora acessível pela TUI.
 *
 * Aqui NÃO reinventamos o compose: o arquivo base do repositório é a fonte
 * única (env, stop_grace_period, logging e limites que o usuário calibrou) e
 * `buildInstanceCompose` só troca nome, config, volume de logs e recursos.
 * Gerar um compose do zero criaria uma segunda verdade que envelheceria em
 * relação ao base.
 *
 * Autostart aqui NÃO é um passo nosso e não pede comando de sistema: o
 * `restart: unless-stopped` do compose base já faz o container voltar sozinho
 * assim que o daemon do Docker sobe — e o daemon subir no boot é o padrão de
 * toda instalação normal (o pacote da distro já habilita `docker.service`;
 * Docker Desktop/WSL/colima sobem pelo próprio mecanismo, onde `systemctl
 * enable docker` nem existe). Mandar o usuário rodar `sudo systemctl enable
 * docker` era, na prática, pedir sudo à toa em quase toda máquina — e quebrava
 * de vez em WSL. Por isso o assunto virou NOTA, e só aparece quando há systemd
 * de sistema real E o `docker.service` está comprovadamente desabilitado.
 */

export const BASE_COMPOSE = "docker-compose-limit.yml";

/**
 * O que se sabe sobre o Docker subir no boot desta máquina.
 * `unitEnabled: null` = não deu para saber (sem systemd, Docker Desktop,
 * comando ausente) — e nesse caso não se diz nada, porque um aviso baseado em
 * "não sei" só assusta.
 */
export type DockerBootInfo = {
	/** há systemd de SISTEMA (não o `--user`) governando os serviços */
	systemdSystem: boolean;
	/** `systemctl is-enabled docker` disse "enabled"? null = indeterminado */
	unitEnabled: boolean | null;
};

/** Probe barato e SEM sudo — `is-enabled` é consulta, não alteração. */
export function probeDockerBoot(): DockerBootInfo {
	if (platform() !== "linux" || !existsSync("/run/systemd/system"))
		return { systemdSystem: false, unitEnabled: null };

	const out = spawnSync("systemctl", ["is-enabled", "docker"], {
		encoding: "utf8",
		timeout: 4000,
	});
	if (out.error) return { systemdSystem: true, unitEnabled: null };

	const state = (out.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
	if (state === "enabled" || state === "enabled-runtime")
		return { systemdSystem: true, unitEnabled: true };
	if (state === "disabled") return { systemdSystem: true, unitEnabled: false };
	// "static", "masked", "not-found", vazio: não é um "desabilitado" que o
	// usuário resolva com enable — melhor calar do que dar instrução errada.
	return { systemdSystem: true, unitEnabled: null };
}

export function composePath(spec: ServiceSpec): string {
	return join(spec.workingDir, `docker-compose-limit-${slug(spec.name)}.yml`);
}

export function dockerPlan(
	spec: ServiceSpec,
	res: ResourceRec,
	/** injetável nos testes; só é sondado quando o autostart está ligado */
	boot?: DockerBootInfo,
): InstallPlan | { error: string } {
	const basePath = join(spec.workingDir, BASE_COMPOSE);
	if (!existsSync(basePath))
		return {
			error: `${BASE_COMPOSE} não existe em ${spec.workingDir} — o backend docker herda dele (limites de RAM/CPU, logging, stop_grace_period).`,
		};

	if (spec.mode !== "sync")
		return {
			error:
				"O compose do pulsar é feito para o sync (daemon 24/7). Para migrate/ttl, que terminam, use systemd/launchd/pm2 ou rode em primeiro plano.",
		};

	const file = composePath(spec);
	// O compose monta a config por caminho relativo ao projeto: um caminho
	// absoluto quebraria o bind mount dentro do container.
	const configRel =
		relative(spec.workingDir, spec.configPath) || basename(spec.configPath);

	const content = buildInstanceCompose(readFileSync(basePath, "utf8"), {
		suffix: slug(spec.name),
		configPath: configRel,
		res,
	});

	const notes = [
		"O container reinicia sozinho (restart: unless-stopped) e volta no boot junto com o daemon do Docker — nenhum comando de sistema é necessário.",
		"Cada instância precisa de um DESTINO diferente: duas apontando para o mesmo banco brigam pelo resume token em __sync.",
	];

	if (spec.autostart) {
		const info = boot ?? probeDockerBoot();
		if (info.systemdSystem && info.unitEnabled === false)
			notes.push(
				"O serviço do Docker está DESABILITADO no boot nesta máquina: o container só volta depois que alguém subir o daemon (systemctl enable docker resolve, com sudo — não é preciso em Docker Desktop/WSL).",
			);
	}

	return {
		backend: "docker",
		serviceName: `pulsar-sync-${slug(spec.name)}`,
		resources: res,
		files: [{ path: file, content }],
		steps: [
			{
				cmd: "docker",
				args: ["compose", "-f", file, "up", "-d", "--build"],
				why: "constrói a imagem e sobe o container em background",
			},
		],
		// Nenhum comando privilegiado: o docker não precisa de sudo para o
		// container voltar sozinho — o restart policy já cobre.
		manualSteps: [],
		notes,
	};
}

export function dockerUninstallSteps(spec: ServiceSpec) {
	return [
		{
			cmd: "docker",
			args: ["compose", "-f", composePath(spec), "down"],
			why: "para e remove o container",
			optional: true,
		},
	];
}

export function dockerServiceName(spec: ServiceSpec): string {
	return `pulsar-sync-${slug(spec.name)}`;
}

/** Só para manter a simetria com os outros backends na tela. */
export { serviceName };
