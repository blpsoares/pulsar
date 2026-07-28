import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { TuiMode } from "../inspect/summary";
import { emptyForm, type FormState } from "./formState";

/**
 * yml existente -> estado do form. É o inverso de `buildConfig`, para abrir uma
 * config já criada e editar na TUI.
 *
 * Perda conhecida e deliberada: entradas de collection com `filter`/`filterFile`
 * viram só o nome no form (a TUI ainda não edita filtro). Por isso os filtros
 * originais voltam em `preservedEntries` — ao salvar por cima, `mergeCollections`
 * os recoloca em vez de apagar silenciosamente o trabalho de quem escreveu o
 * filtro à mão.
 */

/**
 * Entrada crua de collection num yml do pulsar. É a mesma forma nos três
 * modos (string simples ou objeto com `name` + extras), só que os extras
 * mudam: `filter`/`filterFile` no sync, `field`/`expire` no ttl. A TUI não
 * precisa entender os extras — só preservá-los.
 */
export type CollectionEntryRaw =
	| string
	| ({ name: string } & Record<string, unknown>);

export type LoadedConfig = {
	form: FormState;
	/** entradas originais de collection, com filtros, indexadas por nome */
	preservedEntries: Map<string, CollectionEntryRaw>;
};

export function parseConfigObject(parsed: unknown): LoadedConfig | null {
	const cmd = (parsed as { command?: Record<string, unknown> })?.command;
	if (!cmd || typeof cmd !== "object") return null;

	const mode: TuiMode | null =
		"sync" in cmd
			? "sync"
			: "migrate" in cmd
				? "migrate"
				: "ttl" in cmd
					? "ttl"
					: null;
	if (!mode) return null;

	const body = cmd[mode] as Record<string, unknown>;
	const form = emptyForm(mode);
	const preservedEntries = new Map<string, CollectionEntryRaw>();

	const source = body.source as { uri?: string; db?: string } | undefined;
	form.source = { uri: source?.uri ?? "", db: source?.db ?? "" };

	const dest = body.destination as { uri?: string; db?: string } | undefined;
	form.destination = { uri: dest?.uri ?? "", db: dest?.db ?? "" };

	const rawCollections = (body.collections ?? []) as CollectionEntryRaw[];
	for (const entry of rawCollections) {
		const name = typeof entry === "string" ? entry : entry?.name;
		if (!name) continue;
		form.collections.push(name);
		if (typeof entry !== "string") preservedEntries.set(name, entry);
	}

	if (mode === "sync") {
		form.copyIndexes = body.copyIndexes === true;
		const cv = body.copyViews;
		form.copyViews = cv === true ? true : Array.isArray(cv) ? [...cv] : false;

		const logging = (body.logging ?? {}) as {
			verbose?: boolean;
			progress?: boolean;
			lang?: "en" | "pt";
		};
		form.logging = {
			verbose: logging.verbose === true,
			progress: logging.progress !== false,
			lang: logging.lang,
		};
	}

	const perf = (body.performance ?? {}) as {
		parallel?: number;
		batchSize?: number;
		flushIntervalMs?: number;
	};
	form.performance = {
		parallel: perf.parallel,
		batchSize: perf.batchSize,
		flushIntervalMs: perf.flushIntervalMs,
	};

	if (mode === "migrate" && typeof body.queryString === "string")
		form.queryString = body.queryString;

	if (mode === "ttl") {
		const d = (body.defaults ?? {}) as {
			field?: string;
			deriveFromId?: boolean;
			expire?: string | number;
		};
		form.ttlDefaults = {
			field: d.field,
			deriveFromId: d.deriveFromId === true,
			expire: d.expire === undefined ? undefined : String(d.expire),
		};
	}

	return { form, preservedEntries };
}

export function loadConfigFile(path: string): LoadedConfig | null {
	try {
		return parseConfigObject(yaml.load(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

/**
 * Recoloca os filtros preservados nas collections que continuam selecionadas.
 * Collection removida no form some com filtro e tudo — isso é intencional.
 */
export function mergeCollections(
	selected: string[],
	preserved: Map<string, CollectionEntryRaw>,
): CollectionEntryRaw[] {
	return selected.map((name) => preserved.get(name) ?? name);
}
