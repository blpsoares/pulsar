import type { FormState } from "./formState";
import { type CollectionEntryRaw, mergeCollections } from "./loadConfig";

/**
 * Estado do form -> objeto yml do pulsar.
 *
 * Só emite o que foi realmente configurado: campo opcional que ficou no default
 * NÃO vai para o arquivo. Um yml enxuto é legível e, principalmente, continua
 * herdando defaults futuros do pulsar em vez de congelar os de hoje.
 */

export type PulsarConfig = {
	command: Record<string, unknown>;
};

/**
 * `preserved` carrega os filtros de um yml que foi aberto para edição. Sem
 * ele, salvar por cima apagaria `filter`/`filterFile` escritos à mão.
 */
export function buildConfig(
	form: FormState,
	preserved?: Map<string, CollectionEntryRaw>,
): PulsarConfig {
	const collections: CollectionEntryRaw[] = preserved
		? mergeCollections(form.collections, preserved)
		: [...form.collections];

	switch (form.mode) {
		case "sync":
			return { command: { sync: buildSync(form, collections) } };
		case "migrate":
			return { command: { migrate: buildMigrate(form, collections) } };
		case "ttl":
			return { command: { ttl: buildTtl(form, collections) } };
	}
}

function buildSync(
	form: FormState,
	collections: CollectionEntryRaw[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		source: { uri: form.source.uri.trim(), db: form.source.db.trim() },
		destination: {
			uri: form.destination.uri.trim(),
			db: form.destination.db.trim(),
		},
		collections,
	};

	if (form.copyIndexes) out.copyIndexes = true;
	if (form.copyViews === true) out.copyViews = true;
	else if (Array.isArray(form.copyViews) && form.copyViews.length > 0)
		out.copyViews = [...form.copyViews];

	const logging = pruneUndefined({
		// `verbose` só aparece se ligado; `progress` só se DESligado (default true)
		verbose: form.logging.verbose ? true : undefined,
		progress: form.logging.progress === false ? false : undefined,
		lang: form.logging.lang,
	});
	if (Object.keys(logging).length > 0) out.logging = logging;

	const performance = pruneUndefined({
		parallel: form.performance.parallel,
		batchSize: form.performance.batchSize,
		flushIntervalMs: form.performance.flushIntervalMs,
	});
	if (Object.keys(performance).length > 0) out.performance = performance;

	return out;
}

function buildMigrate(
	form: FormState,
	collections: CollectionEntryRaw[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		source: { uri: form.source.uri.trim(), db: form.source.db.trim() },
		destination: {
			uri: form.destination.uri.trim(),
			db: form.destination.db.trim(),
		},
		collections: collections.map((c) => (typeof c === "string" ? c : c.name)),
	};
	if (form.queryString?.trim()) out.queryString = form.queryString.trim();
	return out;
}

function buildTtl(
	form: FormState,
	collections: CollectionEntryRaw[],
): Record<string, unknown> {
	const defaults = pruneUndefined({
		field: form.ttlDefaults.field,
		deriveFromId: form.ttlDefaults.deriveFromId ? true : undefined,
		expire: form.ttlDefaults.expire,
	});

	const out: Record<string, unknown> = {
		source: { uri: form.source.uri.trim(), db: form.source.db.trim() },
		collections,
	};
	if (Object.keys(defaults).length > 0) out.defaults = defaults;

	if (form.performance.parallel)
		out.performance = { parallel: form.performance.parallel };

	return out;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
	const out = {} as T;
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}
