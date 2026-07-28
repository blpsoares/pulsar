import type { Db } from "mongodb";

/**
 * Números por collection — em dois regimes bem separados:
 *
 * - ESTIMATIVA (`estimateCollection`): lê só metadata via `$collStats`. É
 *   ~instantâneo mesmo numa collection de 215M docs, porque não varre nada.
 *   O preço é ser aproximado (o contador de docs é o do catálogo, que pode
 *   divergir após crash) e cego a filtro.
 * - EXATO (`countExact`): `countDocuments`, que varre índice/coleção. Pode
 *   levar minutos. Só roda sob demanda, numa collection por vez, e é o ÚNICO
 *   caminho válido quando existe filtro — a estimativa ignora o filtro por
 *   completo e responderia um número que não tem relação com o que será
 *   enviado.
 */

export type CollEstimate = {
	name: string;
	/** contagem aproximada de documentos (metadata) */
	docs: number;
	/** bytes em disco */
	storageSize: number;
	/** bytes somados de todos os índices */
	totalIndexSize: number;
	/** quantidade de índices (inclui o _id_) */
	indexCount: number;
	/** true quando o número veio de contagem real, não de metadata */
	exact: boolean;
	/** preenchido quando a collection não pôde ser lida (sem permissão etc.) */
	error?: string;
};

export const EMPTY_ESTIMATE: Omit<CollEstimate, "name"> = {
	docs: 0,
	storageSize: 0,
	totalIndexSize: 0,
	indexCount: 0,
	exact: false,
};

/**
 * `$collStats` com `storageStats` devolve count/size/nindexes de uma vez, sem
 * varrer documentos. Falha (permissão, collection sumiu no meio) NÃO derruba a
 * tela: volta um registro zerado com `error` preenchido, e a UI mostra "—".
 */
export async function estimateCollection(
	db: Db,
	name: string,
): Promise<CollEstimate> {
	try {
		const [stats] = await db
			.collection(name)
			.aggregate([{ $collStats: { storageStats: {} } }])
			.toArray();

		const s = (stats?.storageStats ?? {}) as {
			count?: number;
			storageSize?: number;
			totalIndexSize?: number;
			nindexes?: number;
		};

		return {
			name,
			docs: s.count ?? 0,
			storageSize: s.storageSize ?? 0,
			totalIndexSize: s.totalIndexSize ?? 0,
			indexCount: s.nindexes ?? 0,
			exact: false,
		};
	} catch (err) {
		return {
			name,
			...EMPTY_ESTIMATE,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Estima várias collections com paralelismo LIMITADO. Sem o limite, um banco
 * com 200 collections dispararia 200 comandos simultâneos e estouraria o
 * `maxPoolSize` (30) que o pulsar usa de propósito para não saturar o Atlas.
 */
export async function estimateMany(
	db: Db,
	names: string[],
	parallel = 8,
): Promise<CollEstimate[]> {
	const out: CollEstimate[] = [];
	const queue = [...names];

	const workers = Array.from({ length: Math.min(parallel, queue.length) }, () =>
		(async () => {
			while (queue.length > 0) {
				const name = queue.shift();
				if (!name) break;
				out.push(await estimateCollection(db, name));
			}
		})(),
	);

	await Promise.all(workers);
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/**
 * Contagem real. Com filtro é obrigatória — é o único número que responde
 * "quantos docs realmente vão ser enviados".
 */
export async function countExact(
	db: Db,
	name: string,
	filter: Record<string, unknown> = {},
): Promise<number> {
	return db.collection(name).countDocuments(filter);
}

/** "1.2 GB", "340 MB" — para caber na largura de uma coluna do terminal. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	const i = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** i;
	const digits = value >= 100 || i === 0 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[i]}`;
}

/** "1.2M", "215M", "8.4K" — idem, contagem de docs em coluna estreita. */
export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1000) return String(n);
	const units = [
		{ v: 1e9, s: "B" },
		{ v: 1e6, s: "M" },
		{ v: 1e3, s: "K" },
	];
	for (const u of units) {
		if (n >= u.v) {
			const value = n / u.v;
			return `${value.toFixed(value >= 100 ? 0 : 1)}${u.s}`;
		}
	}
	return String(n);
}
