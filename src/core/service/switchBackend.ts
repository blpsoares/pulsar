import { type ServiceRecord, writeRecord } from "../state/registry";
import { buildPlan, installService, uninstallService } from "./manager";
import type { AskCallback, SudoMode } from "./privileged";
import type { Backend, ServiceSpec } from "./types";

/**
 * Migrar um serviço de supervisor sem deixar o usuário sem serviço nenhum.
 *
 * A troca é destrutiva por natureza: para instalar no novo é preciso remover do
 * antigo, e é exatamente no meio disso que uma falha do novo backend (daemon do
 * docker fora do ar, pm2 sem permissão) deixaria a máquina sem nada rodando. O
 * rollback reinstala o antigo — e quando nem isso funciona, o resultado diz
 * `rolledBack: false` em vez de fingir que está tudo bem.
 *
 * As operações entram por parâmetro para o teste não precisar de supervisor.
 */

export type SwitchOutcome =
	| { ok: true; record: ServiceRecord }
	| { ok: false; error: string; rolledBack: boolean };

export type SwitchOps = {
	home?: string;
	uninstall: (backend: Backend, record: ServiceRecord) => Promise<void>;
	install: (
		backend: Backend,
		record: ServiceRecord,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	save: (record: ServiceRecord) => void;
};

export function defaultOps(opts: {
	sudo: SudoMode;
	ask: AskCallback;
	home?: string;
}): SwitchOps {
	// `record.name` já vem com o prefixo `pulsar-` (é o que `serviceName()`
	// produz); `ServiceSpec.name` é só o sufixo, porque `serviceName()` reaplica
	// o prefixo sozinho. Sem tirar aqui, o serviço novo nasceria como
	// `pulsar-pulsar-x` — nome diferente do antigo, e a troca vira criação (o
	// antigo não é achado para desinstalar, o novo não é achado depois).
	const toSpec = (record: ServiceRecord): ServiceSpec => ({
		name: record.name.replace(/^pulsar-/, ""),
		mode: record.mode,
		configPath: record.config,
		workingDir: record.workingDir,
		autostart: record.boot,
	});

	return {
		home: opts.home,
		uninstall: async (backend, record) => {
			await uninstallService(backend, toSpec(record));
		},
		install: async (backend, record) => {
			const plan = buildPlan(backend, toSpec(record));
			if ("error" in plan) return { ok: false, error: plan.error };

			const result = await installService(plan, toSpec(record), {
				sudo: opts.sudo,
				ask: opts.ask,
			});
			return result.ok
				? { ok: true }
				: {
						ok: false,
						error:
							result.results.find((r) => !r.ok)?.output ??
							"a instalação falhou sem mensagem",
					};
		},
		save: (record) => writeRecord(record, opts.home),
	};
}

export async function switchBackend(
	record: ServiceRecord,
	target: Backend,
	ops: SwitchOps,
): Promise<SwitchOutcome> {
	// Mesmo backend: nada para trocar — e principalmente nada para desinstalar,
	// já que desinstalar o único backend em pé sem reinstalar nada é o próprio
	// desfecho que este comando existe para evitar.
	if (record.backend === target) return { ok: true, record };

	const previous = record.backend;
	await ops.uninstall(previous, record);

	const installed = await ops.install(target, { ...record, backend: target });
	if (installed.ok) {
		const updated = { ...record, backend: target };
		ops.save(updated);
		return { ok: true, record: updated };
	}

	// O novo falhou com o antigo já removido — reinstala o antigo com o
	// registro ORIGINAL (backend antigo), não o `record` já mutado para o alvo.
	const back = await ops.install(previous, record);
	return { ok: false, error: installed.error, rolledBack: back.ok };
}
