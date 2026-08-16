import type { RunMode } from "../run/pulsarCommand";
import type { DiscoveredService } from "../service/discover";
import { supervisorNameOf } from "../service/fromRecord";
import type { ServiceRecord } from "./registry";

/**
 * A lista da tela é o cruzamento de duas fontes que sabem coisas diferentes.
 *
 * O registro sabe o SIGNIFICADO (é um migrate, aponta para este yml, copiou
 * 1.2M docs). O supervisor sabe a VERDADE VIVA (está no ar agora, sobe no
 * boot). Nenhuma das duas basta, e as duas podem discordar — serviço removido
 * à mão, registro apagado, TUI antiga. Os quatro casos aparecem na lista, com
 * ações diferentes, em vez de um deles sumir e o usuário achar que perdeu algo.
 */

export type ServiceState =
	| "running"
	| "stopped"
	| "done"
	| "failed"
	| "uninstalled"
	| "adopted";

export type ServiceRow = {
	name: string;
	state: ServiceState;
	record: ServiceRecord | null;
	live: DiscoveredService | null;
};

/** `migrate` e `ttl` terminam; `sync` não. */
export function isOneShot(mode: RunMode): boolean {
	return mode === "migrate" || mode === "ttl";
}

export function reconcile(
	records: ServiceRecord[],
	live: DiscoveredService[],
): ServiceRow[] {
	// O cruzamento é pelo nome QUE O SUPERVISOR usa, não pelo do registro: no
	// docker o container é `pulsar-sync-<slug>` e no launchd o agent é
	// `com.pulsar.<slug>`, enquanto o registro guarda `pulsar-<slug>` nos quatro
	// backends. Cruzando por nome cru, todo serviço docker ou launchd saía em
	// DUAS linhas — "não instalado" (o registro sem par) e "adotado" (o
	// supervisor sem par) — e `a` na segunda gravava um registro duplicado.
	const byName = new Map(live.map((service) => [service.name, service]));
	const seen = new Set<string>();
	const rows: ServiceRow[] = [];

	for (const record of records) {
		const liveName = supervisorNameOf(record);
		// A rede: um serviço criado à mão e adotado pode ter um nome fora do
		// padrão (um container `pulsar-loja`, sem o `-sync-`). Aí o nome derivado
		// não acha nada, mas o nome do registro é literalmente o do supervisor —
		// e é assim que ele foi adotado. A checagem de backend impede confundir
		// uma unit do systemd com um container homônimo.
		const fallback = byName.get(record.name);
		const found =
			byName.get(liveName) ??
			(fallback?.backend === record.backend ? fallback : null);
		seen.add(liveName);
		if (found) seen.add(found.name);
		rows.push({
			name: record.name,
			state: stateFor(record, found),
			record,
			live: found,
		});
	}

	for (const service of live) {
		if (seen.has(service.name)) continue;
		rows.push({
			name: service.name,
			state: "adopted",
			record: null,
			live: service,
		});
	}

	return rows.sort(
		(a, b) =>
			Number(b.state === "running") - Number(a.state === "running") ||
			a.name.localeCompare(b.name),
	);
}

function stateFor(
	record: ServiceRecord,
	live: DiscoveredService | null,
): ServiceState {
	if (!live) return "uninstalled";
	if (live.running) return "running";

	// Parado é ambíguo: um sync parado foi PARADO, um migrate parado TERMINOU.
	// Só o modo e o resultado distinguem, e é essa distinção que o usuário vê.
	if (isOneShot(record.mode) && record.lastRun?.status === "ok") return "done";
	if (isOneShot(record.mode) && record.lastRun?.status === "error")
		return "failed";

	// Processo morreu sem conseguir gravar o desfecho: kill -9, OOM killer, queda
	// de VM. O lastRun.status fica preso em "running". Para um one-shot, isso é
	// falha — a execução não completou. Um sync nessa situação é só "parado".
	if (isOneShot(record.mode) && record.lastRun?.status === "running")
		return "failed";

	return "stopped";
}
