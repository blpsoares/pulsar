import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RunMode } from "../run/pulsarCommand";
import type { Backend } from "../service/types";

/**
 * O que o pulsar sabe sobre um serviço além do que o supervisor conta.
 *
 * `discoverServices()` responde "existe e está no ar"; não responde "é um
 * migrate, aponta para este yml, e da última vez copiou 1.2M documentos". Esse
 * segundo conjunto não cabe em nenhum supervisor, e precisa sobreviver à TUI
 * fechada: o serviço roda no boot às 3h da manhã e o resultado tem que estar
 * aqui quando alguém abrir a tela.
 *
 * Um arquivo por serviço (e não um índice único) porque dois processos podem
 * terminar ao mesmo tempo — com arquivo por serviço, cada um escreve o seu e
 * não há disputa por um índice compartilhado.
 */

export const CREATED_BY_TUI = "pulsar-tui";

const lastRunSchema = z.object({
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	status: z.enum(["ok", "error", "running"]),
	exitCode: z.number().nullable(),
	stats: z.record(z.string(), z.number()),
	error: z.string().nullable(),
});

const recordSchema = z.object({
	name: z.string().min(1),
	mode: z.enum(["sync", "migrate", "ttl"]),
	config: z.string().min(1),
	workingDir: z.string().min(1),
	backend: z.enum(["systemd", "launchd", "pm2", "docker"]),
	boot: z.boolean(),
	createdBy: z.string(),
	lastRun: lastRunSchema.nullable(),
});

export type LastRun = z.infer<typeof lastRunSchema>;
export type RunStats = LastRun["stats"];
export type ServiceRecord = z.infer<typeof recordSchema> & {
	mode: RunMode;
	backend: Backend;
};

export function registryDir(home: string = homedir()): string {
	return join(home, ".pulsar", "services");
}

function recordPath(name: string, home?: string): string {
	return join(registryDir(home), `${name}.json`);
}

export function readRecord(name: string, home?: string): ServiceRecord | null {
	return parseFile(recordPath(name, home));
}

export function writeRecord(record: ServiceRecord, home?: string): void {
	const dir = registryDir(home);
	mkdirSync(dir, { recursive: true });

	// tmp + rename: um Ctrl+C no meio da escrita não deixa um registro pela
	// metade no lugar de um que funcionava. Mesmo padrão do writeConfig.
	const target = recordPath(record.name, home);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
	renameSync(tmp, target);
}

export function listRecords(home?: string): ServiceRecord[] {
	const dir = registryDir(home);
	if (!existsSync(dir)) return [];

	const out: ServiceRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const record = parseFile(join(dir, file));
		if (record) out.push(record);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function removeRecord(name: string, home?: string): void {
	rmSync(recordPath(name, home), { force: true });
}

/**
 * Registro ilegível (json quebrado, schema antigo, arquivo truncado) devolve
 * `null` em vez de jogar: a lista de serviços inteira não pode sumir por causa
 * de um arquivo estragado. Quem some é o significado daquele serviço, e ele
 * reaparece como "adotado".
 */
function parseFile(path: string): ServiceRecord | null {
	try {
		const parsed = recordSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")),
		);
		return parsed.success ? (parsed.data as ServiceRecord) : null;
	} catch {
		return null;
	}
}
