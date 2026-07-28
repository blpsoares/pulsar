import type { Db } from "mongodb";

/**
 * Resumo dos índices de uma collection. A TUI usa isso para responder "o que
 * mais vai junto além dos documentos" — no `sync` com `copyIndexes: true` os
 * índices secundários são recriados no destino, e saber quantos são antes de
 * disparar evita surpresa (build de índice em collection grande é caro).
 */

export type IndexInfo = {
	name: string;
	key: Record<string, unknown>;
	unique: boolean;
	/** índice TTL: tem expireAfterSeconds */
	ttl: boolean;
};

export type CollIndexes = {
	collection: string;
	indexes: IndexInfo[];
	/** índices que o sync realmente criaria (todos menos o _id_, que já existe) */
	secondaryCount: number;
	error?: string;
};

export async function indexSummary(db: Db, name: string): Promise<CollIndexes> {
	try {
		const raw = await db.collection(name).listIndexes().toArray();
		const indexes: IndexInfo[] = raw.map((i) => ({
			name: String(i.name),
			key: (i.key ?? {}) as Record<string, unknown>,
			unique: i.unique === true,
			ttl: i.expireAfterSeconds !== undefined,
		}));

		return {
			collection: name,
			indexes,
			secondaryCount: indexes.filter((i) => i.name !== "_id_").length,
		};
	} catch (err) {
		return {
			collection: name,
			indexes: [],
			secondaryCount: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Mesma limitação de paralelismo do collStats: não estourar o pool. */
export async function indexSummaryMany(
	db: Db,
	names: string[],
	parallel = 8,
): Promise<CollIndexes[]> {
	const out: CollIndexes[] = [];
	const queue = [...names];

	const workers = Array.from({ length: Math.min(parallel, queue.length) }, () =>
		(async () => {
			while (queue.length > 0) {
				const name = queue.shift();
				if (!name) break;
				out.push(await indexSummary(db, name));
			}
		})(),
	);

	await Promise.all(workers);
	out.sort((a, b) => a.collection.localeCompare(b.collection));
	return out;
}
