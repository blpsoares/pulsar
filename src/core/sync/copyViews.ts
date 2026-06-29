// src/core/sync/copyViews.ts
import type { Db, Document } from "mongodb";

export type ViewDef = {
	name: string;
	viewOn: string;
	pipeline: Document[];
	collation?: Document;
};

export type ViewCopyResult = {
	created: number;
	updated: number;
	skipped: number;
	failed: { name: string; reason: string }[];
	createdNames: string[];
	updatedNames: string[];
};

/** JSON canônico (chaves ordenadas) p/ comparar opções order-insensitive. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys
		.map(
			(k) =>
				`${JSON.stringify(k)}:${stableStringify(
					(value as Record<string, unknown>)[k],
				)}`,
		)
		.join(",")}}`;
}

/** Assinatura de uma view: viewOn + pipeline (ordem SIGNIFICATIVA → JSON.stringify)
 *  + collation (order-insensitive → canonicalizada). Defs equivalentes batem. */
function signature(d: {
	viewOn?: string;
	pipeline?: Document[];
	collation?: Document;
}): string {
	return `${d.viewOn ?? ""}|${JSON.stringify(d.pipeline ?? [])}|${stableStringify(
		d.collation ?? null,
	)}`;
}

/**
 * Lista as views da origem (metadados puros: viewOn + pipeline). Se `names` for
 * passado, filtra só essas. Ignora entradas sem `viewOn` (defensivo).
 */
export async function listSourceViews(
	srcDb: Db,
	names?: string[],
): Promise<ViewDef[]> {
	const wanted = names ? new Set(names) : null;
	const cols = await srcDb
		.listCollections({ type: "view" }, { nameOnly: false })
		.toArray();
	const defs: ViewDef[] = [];
	for (const c of cols) {
		if (wanted && !wanted.has(c.name)) continue;
		const o = (c.options ?? {}) as {
			viewOn?: string;
			pipeline?: Document[];
			collation?: Document;
		};
		if (!o.viewOn) continue;
		defs.push({
			name: c.name,
			viewOn: o.viewOn,
			pipeline: o.pipeline ?? [],
			...(o.collation ? { collation: o.collation } : {}),
		});
	}
	return defs;
}

/**
 * Garante UMA view no destino, idempotente e SEM destruir dado:
 * - não existe → `createCollection({ viewOn, pipeline })`
 * - existe e idêntica → `skipped`
 * - existe e DIFERE → drop + recreate (fica IDÊNTICA à origem)
 * - existe como COLLECTION real de mesmo nome → ERRO (não clobbera dado).
 *
 * Por que drop+recreate e não `collMod`: (a) garante identidade TOTAL com a
 * origem (inclusive collation, que `collMod` não altera em view); (b) funciona
 * com a role `readWrite` (que inclui drop/createCollection) — `collMod` exigiria
 * `dbAdmin`. Dropar uma VIEW não perde dado: view é metadado puro (sem
 * documentos, não passa por dump nem change stream).
 */
export async function ensureView(
	destDb: Db,
	def: ViewDef,
): Promise<"created" | "updated" | "skipped"> {
	const existing = (
		await destDb
			.listCollections({ name: def.name }, { nameOnly: false })
			.toArray()
	)[0];

	if (existing) {
		if (existing.type !== "view") {
			throw new Error(
				`destino já tem uma COLLECTION "${def.name}" (não uma view) — pulando p/ não destruir dado`,
			);
		}
		const cur = (existing.options ?? {}) as {
			viewOn?: string;
			pipeline?: Document[];
			collation?: Document;
		};
		if (signature(cur) === signature(def)) return "skipped";
		// Difere: dropa e recria IDÊNTICA à origem (view não tem dado a perder).
		await destDb.dropCollection(def.name);
		await destDb.createCollection(def.name, {
			viewOn: def.viewOn,
			pipeline: def.pipeline,
			...(def.collation ? { collation: def.collation } : {}),
		});
		return "updated";
	}

	await destDb.createCollection(def.name, {
		viewOn: def.viewOn,
		pipeline: def.pipeline,
		...(def.collation ? { collation: def.collation } : {}),
	});
	return "created";
}

/**
 * Migra as views da origem pro destino EM PARALELO. Cada view é independente
 * (metadado), então roda concorrente; erro de uma é CONTIDO (entra em `failed`)
 * e não derruba as outras nem o sync. Nunca remove view só-do-destino.
 *
 * `names`: undefined/true upstream = todas; array = só as nomeadas.
 */
export async function copyViews(
	srcDb: Db,
	destDb: Db,
	names?: string[],
): Promise<ViewCopyResult> {
	const result: ViewCopyResult = {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: [],
		createdNames: [],
		updatedNames: [],
	};

	const defs = await listSourceViews(srcDb, names);

	const settled = await Promise.allSettled(
		defs.map((def) =>
			ensureView(destDb, def).then((outcome) => ({ def, outcome })),
		),
	);

	for (let i = 0; i < settled.length; i++) {
		const s = settled[i];
		if (s.status === "fulfilled") {
			const { def, outcome } = s.value;
			if (outcome === "created") {
				result.created++;
				result.createdNames.push(def.name);
			} else if (outcome === "updated") {
				result.updated++;
				result.updatedNames.push(def.name);
			} else {
				result.skipped++;
			}
		} else {
			const reason =
				s.reason instanceof Error ? s.reason.message : String(s.reason);
			result.failed.push({ name: defs[i].name, reason });
		}
	}

	return result;
}
