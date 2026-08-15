import type { RunMode } from "../run/pulsarCommand";
import type { DiscoveredService } from "../service/discover";
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
	const byName = new Map(live.map((service) => [service.name, service]));
	const seen = new Set<string>();
	const rows: ServiceRow[] = [];

	for (const record of records) {
		const found = byName.get(record.name) ?? null;
		seen.add(record.name);
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

	return "stopped";
}
