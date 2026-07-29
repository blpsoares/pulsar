import type { Db } from "mongodb";

/**
 * Retrato do banco inteiro em UMA chamada (`dbStats`).
 *
 * É o que responde "o que tem aqui dentro?" assim que a connection string é
 * aceita: quantas collections, quantas views, quantos índices, quanto ocupa.
 * O comando lê metadata do catálogo — não varre documento nenhum — então
 * responde em milissegundos mesmo num banco de bilhões de docs, ao contrário
 * de somar `countDocuments` por collection.
 *
 * Os números de documentos (`objects`) são os do catálogo: aproximados, pelo
 * mesmo motivo que os do `$collStats`. A TUI os marca com `~`.
 */

export type DbSummary = {
	collections: number;
	views: number;
	/** documentos, aproximado (catálogo) */
	objects: number;
	dataSize: number;
	storageSize: number;
	indexes: number;
	indexSize: number;
	error?: string;
};

export const EMPTY_SUMMARY: DbSummary = {
	collections: 0,
	views: 0,
	objects: 0,
	dataSize: 0,
	storageSize: 0,
	indexes: 0,
	indexSize: 0,
};

export async function dbSummary(db: Db): Promise<DbSummary> {
	try {
		const stats = (await db.command({ dbStats: 1 })) as Record<string, unknown>;
		return {
			collections: num(stats.collections),
			views: num(stats.views),
			objects: num(stats.objects),
			dataSize: num(stats.dataSize),
			storageSize: num(stats.storageSize),
			indexes: num(stats.indexes),
			indexSize: num(stats.indexSize),
		};
	} catch (err) {
		// Usuário sem permissão de dbStats ainda consegue usar a TUI: o resumo
		// simplesmente não aparece, em vez de a tela quebrar.
		return {
			...EMPTY_SUMMARY,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function num(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}
