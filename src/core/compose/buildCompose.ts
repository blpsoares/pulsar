import type { ResourceRec } from "./recommend";

export type InstanceOpts = {
	suffix: string; // "2" -> pulsar-sync-2
	configPath: string; // "configs/sync2.yml" (relativo ao projeto)
	res: ResourceRec;
};

/** Substitui o valor de uma chave YAML (preserva indentação/comentários). */
function setYamlValue(src: string, key: string, value: string): string {
	const re = new RegExp(`^(\\s*${key}:\\s*).*$`, "m");
	return src.replace(re, `$1${value}`);
}

/**
 * Gera o compose da nova instância a partir do `docker-compose-limit.yml` base
 * (lido do disco — fonte única), trocando: nome do serviço/container, config do
 * command + volume, volume de logs e os 4 valores de recurso. Tudo o mais (env,
 * stop_grace, logging...) é herdado do base.
 */
export function buildInstanceCompose(
	baseSrc: string,
	opts: InstanceOpts,
): string {
	const name = `pulsar-sync-${opts.suffix}`;
	let src = baseSrc;

	// service key (a linha "  pulsar-sync:" com 2 espaços de indentação)
	src = src.replace(/^ {2}pulsar-sync:$/m, `  ${name}:`);
	// container_name
	src = src.replace(/^(\s*container_name:\s*).*$/m, `$1${name}`);
	// command: troca o caminho da config citado logo após "sync" (qualquer caminho,
	// não só configs/*.yml — o base pode apontar pra um yml na raiz). Preserva
	// args extras (ex.: -p N) depois do caminho.
	src = src.replace(
		/(command:\s*\[[^\]]*?"sync"\s*,\s*")[^"]+(")/,
		`$1${opts.configPath}$2`,
	);
	// volume da config (a linha de mount terminada em :ro de um .yml — qualquer
	// caminho, raiz ou configs/). O volume de logs não tem :ro, então não casa.
	src = src.replace(
		/^(\s*-\s*)\.\/[^:]+\.ya?ml:\/app\/[^:]+\.ya?ml:ro(.*)$/m,
		`$1./${opts.configPath}:/app/${opts.configPath}:ro$2`,
	);
	// volume de logs próprio
	src = src.replace(
		/^(\s*-\s*)\.\/logs:\/app\/logs(.*)$/m,
		`$1./logs-${opts.suffix}:/app/logs$2`,
	);

	src = setYamlValue(src, "mem_limit", `${opts.res.memLimitMiB}m`);
	src = setYamlValue(src, "memswap_limit", `${opts.res.memLimitMiB}m`);
	src = setYamlValue(src, "mem_reservation", `${opts.res.memReservMiB}m`);
	src = setYamlValue(src, "cpus", String(opts.res.cpus));

	return src;
}
