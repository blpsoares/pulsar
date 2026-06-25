import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export type ConfigKind = "sync" | "migrate" | "ttl" | "desconhecido";

export type DetectedConfig = {
	file: string; // caminho relativo ao dir de busca
	kind: ConfigKind;
	sourceDb?: string;
	destDb?: string;
};

/**
 * Classifica um yml já parseado pela chave de topo do pulsar
 * (command.sync / command.migrate / command.ttl). Função pura.
 */
export function classifyConfig(parsed: unknown): Omit<DetectedConfig, "file"> {
	const cmd = (parsed as { command?: Record<string, unknown> })?.command;
	if (!cmd || typeof cmd !== "object") return { kind: "desconhecido" };

	if ("sync" in cmd) {
		const s = cmd.sync as {
			source?: { db?: string };
			destination?: { db?: string };
		};
		return {
			kind: "sync",
			sourceDb: s?.source?.db,
			destDb: s?.destination?.db,
		};
	}
	if ("migrate" in cmd) {
		const m = cmd.migrate as {
			source?: { db?: string };
			destination?: { db?: string };
		};
		return {
			kind: "migrate",
			sourceDb: m?.source?.db,
			destDb: m?.destination?.db,
		};
	}
	if ("ttl" in cmd) {
		const t = cmd.ttl as { source?: { db?: string } };
		return { kind: "ttl", sourceDb: t?.source?.db };
	}
	return { kind: "desconhecido" };
}

/**
 * Varre `dir` (não-recursivo) por *.yml/*.yaml, parseia leve e classifica cada
 * um. Arquivos que não parseiam são ignorados. Útil pra sugerir configs no
 * `pulsar compose up`.
 */
export function detectConfigs(dir: string): DetectedConfig[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const out: DetectedConfig[] = [];
	for (const name of entries) {
		if (!/\.ya?ml$/i.test(name)) continue;
		try {
			const parsed = yaml.load(readFileSync(join(dir, name), "utf8"));
			out.push({ file: name, ...classifyConfig(parsed) });
		} catch {
			// arquivo ilegível/malformado -> ignora
		}
	}
	return out;
}
