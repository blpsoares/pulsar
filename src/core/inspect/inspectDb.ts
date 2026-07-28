import type { Db } from "mongodb";

/**
 * Introspecção do banco de ORIGEM para alimentar o form da TUI.
 *
 * Regra de ouro deste módulo: nada aqui pode ser caro por padrão. A TUI chama
 * isso assim que o usuário digita a connection string — num Atlas com 200
 * collections e bilhões de docs, um `countDocuments` por collection levaria
 * minutos e ainda geraria carga real no cluster de produção. Por isso a
 * listagem usa só metadata (`listCollections`) e as contagens vivem em
 * `collStats.ts`, atrás de um toggle explícito.
 */

export type EntryKind = "collection" | "view";

export type DbEntry = {
	name: string;
	kind: EntryKind;
	/** só para views: a collection/view de base */
	viewOn?: string;
	/** só para views: o pipeline da definição */
	pipeline?: Record<string, unknown>[];
};

export type DbOverview = {
	collections: DbEntry[];
	views: DbEntry[];
};

/**
 * Lista collections e views do banco em UMA chamada (`listCollections` devolve
 * os dois, discriminados por `type`). Collections do sistema e a `__sync` do
 * pulsar ficam de fora — não são dado do usuário e nunca devem entrar num yml.
 */
export async function inspectDb(db: Db): Promise<DbOverview> {
	const raw = await db.listCollections({}, { nameOnly: false }).toArray();

	const collections: DbEntry[] = [];
	const views: DbEntry[] = [];

	for (const info of raw) {
		const name = String(info.name);
		if (isInternalName(name)) continue;

		if (info.type === "view") {
			const opts = (info.options ?? {}) as {
				viewOn?: string;
				pipeline?: Record<string, unknown>[];
			};
			views.push({
				name,
				kind: "view",
				viewOn: opts.viewOn,
				pipeline: opts.pipeline,
			});
			continue;
		}

		collections.push({ name, kind: "collection" });
	}

	collections.sort((a, b) => a.name.localeCompare(b.name));
	views.sort((a, b) => a.name.localeCompare(b.name));

	return { collections, views };
}

/**
 * `system.*` é do Mongo; `__sync` é o estado interno do pulsar no destino
 * (resume token / carimbos de dump). Sincronizar qualquer um dos dois seria
 * corromper metadado.
 */
export function isInternalName(name: string): boolean {
	return name.startsWith("system.") || name === "__sync";
}

/**
 * Filtro incremental do campo de busca. Case-insensitive e por substring —
 * é o que o usuário espera ao digitar "ord" e ver "orders"/"pre_orders".
 * Query vazia devolve a lista inteira (não zera a tela enquanto digita).
 */
export function filterEntries<T extends { name: string }>(
	entries: T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return entries;
	return entries.filter((e) => e.name.toLowerCase().includes(q));
}
