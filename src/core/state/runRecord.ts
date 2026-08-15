import { type RunStats, readRecord, writeRecord } from "./registry";

/**
 * O resultado da última execução, gravado pelo PRÓPRIO processo do pulsar.
 *
 * Não dá para a TUI observar isso de fora: o serviço roda no boot, sem
 * ninguém olhando, e termina horas depois. Quem sabe quantos documentos foram
 * copiados é quem os copiou — os números já existem (são os mesmos do painel
 * final), só estavam virando texto e se perdendo.
 *
 * Execução avulsa (`pulsar sync x.yml` no terminal) não tem
 * `PULSAR_SERVICE_NAME` e não grava nada: não é um serviço e não deve inventar
 * um registro.
 */

export function serviceNameFromEnv(): string | null {
	return process.env.PULSAR_SERVICE_NAME || null;
}

export function beginRun(name: string, home?: string): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				startedAt: new Date().toISOString(),
				endedAt: null,
				status: "running",
				exitCode: null,
				stats: {},
				error: null,
			},
		},
		home,
	);
}

export function finishRun(
	name: string,
	outcome: {
		status: "ok" | "error";
		exitCode: number | null;
		stats: RunStats;
		error?: string | null;
	},
	home?: string,
): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				// Preserva o início marcado pelo beginRun; sem ele, a duração seria 0.
				startedAt: record.lastRun?.startedAt ?? new Date().toISOString(),
				endedAt: new Date().toISOString(),
				status: outcome.status,
				exitCode: outcome.exitCode,
				stats: outcome.stats,
				error: outcome.error ?? null,
			},
		},
		home,
	);
}
