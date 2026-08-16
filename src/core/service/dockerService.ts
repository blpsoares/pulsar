import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { buildInstanceCompose } from "../compose/buildCompose";
import type { ResourceRec } from "../compose/recommend";
import {
	type InstallPlan,
	type ServiceSpec,
	serviceName,
	slug,
	supervisorName,
} from "./types";

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
 * Autostart aqui não é um passo nosso: quem garante é `restart: unless-stopped`
 * (já no base) somado ao serviço do Docker estar habilitado no boot.
 */

export const BASE_COMPOSE = "docker-compose-limit.yml";

export function composePath(spec: ServiceSpec): string {
	return join(spec.workingDir, `docker-compose-limit-${slug(spec.name)}.yml`);
}

export function dockerPlan(
	spec: ServiceSpec,
	res: ResourceRec,
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
		env: {
			// O valor é o nome DO REGISTRO (`pulsar-<slug>`), não o do container
			// (`pulsar-sync-<slug>`): é por ele que o processo acha o próprio
			// arquivo em ~/.pulsar/services para gravar o resultado da execução.
			PULSAR_SERVICE_NAME: serviceName(spec),
		},
	});

	const notes = [
		"O container reinicia sozinho (restart: unless-stopped) e volta no boot se o serviço do Docker estiver habilitado.",
		"Cada instância precisa de um DESTINO diferente: duas apontando para o mesmo banco brigam pelo resume token em __sync.",
	];

	const manualSteps: InstallPlan["manualSteps"] = [];
	if (spec.autostart) {
		manualSteps.push({
			cmd: "sudo",
			args: ["systemctl", "enable", "docker"],
			why: "faz o próprio Docker subir no boot (sem isso, nenhum container volta)",
			privileged: true,
		});
	}

	return {
		backend: "docker",
		serviceName: dockerServiceName(spec),
		files: [{ path: file, content }],
		steps: [
			{
				cmd: "docker",
				args: ["compose", "-f", file, "up", "-d", "--build"],
				why: "constrói a imagem e sobe o container em background",
				// A PRIMEIRA construção baixa a base, roda `apk add mongodb-tools`,
				// `bun install` e compila o binário — em VM modesta passa fácil dos
				// 10 min. Com o teto padrão de 2 min, o build era interrompido no
				// meio e NENHUM container chegava a existir: a tela dizia que falhou
				// (ou nem isso) e não havia nada em `docker ps`. Da segunda vez em
				// diante o cache faz em segundos.
				timeoutMs: 30 * 60_000,
			},
		],
		manualSteps,
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

/** O container tem nome PRÓPRIO (`pulsar-sync-<slug>`), diferente do registro. */
export function dockerServiceName(spec: Pick<ServiceSpec, "name">): string {
	return supervisorName("docker", spec);
}

/** Só para manter a simetria com os outros backends na tela. */
export { serviceName };
