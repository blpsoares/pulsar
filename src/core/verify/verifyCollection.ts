// src/core/verify/verifyCollection.ts
import type { Collection, Document } from "mongodb";
import { idKey } from "../../utils/idKey";
import { writeDocToDest } from "../sync/writeDoc";

export type VerifyMode = "count" | "deep";

export type VerifyResult = {
	coll: string;
	/** Docs na origem que casam com o filtro da config. */
	sourceCount: number;
	/** Docs no destino. */
	destCount: number;
	/** `true` quando as contagens vieram de metadados (`estimatedDocumentCount`). */
	approximate: boolean;
	/** Quantos `_id` da origem NÃO existem no destino. `-1` no modo `count`. */
	missing: number;
	/** Amostra dos `_id` faltantes (limitada por `sampleLimit`). */
	missingSample: unknown[];
	/** Quantos docs foram efetivamente recopiados (só com `reconcile`). */
	reconciled: number;
	mode: VerifyMode;
	/** Erro contido: uma collection que falha não derruba a verificação das outras. */
	error?: string;
};

export type VerifyOptions = {
	filter?: Document;
	mode?: VerifyMode;
	/** Docs por rodada de comparação `$in` (default 2000). */
	batchSize?: number;
	/** Máx. de `_id`s faltantes guardados na amostra (default 20). */
	sampleLimit?: number;
	/** Recopia da origem os docs faltantes encontrados (só no modo `deep`). */
	reconcile?: boolean;
	/** Progresso do scan profundo (docs varridos da origem). */
	onProgress?: (scanned: number, missing: number) => void;
};

/**
 * Contagem do lado da origem. Sem filtro usamos os metadados
 * (`estimatedDocumentCount`, instantâneo); com filtro não há atalho — precisa
 * ser exato pra comparação valer alguma coisa.
 */
async function countSide(
	col: Collection,
	filter?: Document,
): Promise<{ n: number; approximate: boolean }> {
	if (!filter || Object.keys(filter).length === 0) {
		return { n: await col.estimatedDocumentCount(), approximate: true };
	}
	return { n: await col.countDocuments(filter), approximate: false };
}

/**
 * Confere uma collection entre origem e destino.
 *
 * POR QUE ISTO EXISTE: o `sync` decide "está em dia" olhando o carimbo
 * `dumpCompletedAt` no `__sync` do destino — um registro de BOOKKEEPING, nunca
 * uma medição do dado. Se um dump foi carimbado por engano (foi o caso do bug de
 * colisão de `_id` composto), a collection retoma para sempre e o change stream
 * jamais reconcilia: ele só entrega mudança NOVA, nunca reinjeta um doc
 * pré-existente que ficou para trás. Sem uma verificação que compare dado com
 * dado, "52/52 up to date" é uma afirmação que ninguém mediu.
 *
 * - `count`: só compara os totais. Barato, pega buracos grandes.
 * - `deep`: varre os `_id` da origem em lotes e confere um a um no destino.
 *   Exato, e é o único modo que diz QUAIS docs faltam.
 */
export async function verifyCollection(
	srcCol: Collection,
	destCol: Collection,
	opts: VerifyOptions = {},
): Promise<VerifyResult> {
	const mode = opts.mode ?? "count";
	const batchSize = opts.batchSize ?? 2000;
	const sampleLimit = opts.sampleLimit ?? 20;
	const filter = opts.filter;

	const result: VerifyResult = {
		coll: destCol.collectionName,
		sourceCount: 0,
		destCount: 0,
		approximate: false,
		missing: -1,
		missingSample: [],
		reconciled: 0,
		mode,
	};

	try {
		const [s, d] = await Promise.all([
			countSide(srcCol, filter),
			countSide(destCol),
		]);
		result.sourceCount = s.n;
		result.destCount = d.n;
		result.approximate = s.approximate || d.approximate;

		if (mode === "count") return result;

		// ── modo deep ───────────────────────────────────────────────────────────
		// Varre os _id da origem em lotes e pergunta ao destino quais existem. A
		// comparação é por `idKey` (canônica): `String(_id)` colapsaria todo _id
		// composto numa chave só e o resultado da auditoria seria ficção.
		result.missing = 0;
		let scanned = 0;
		let page: unknown[] = [];

		const checkPage = async () => {
			if (page.length === 0) return;
			const present = await destCol
				.find({ _id: { $in: page as never[] } }, { projection: { _id: 1 } })
				.toArray();
			const have = new Set(present.map((p) => idKey(p._id)));
			const gone = page.filter((id) => !have.has(idKey(id)));

			if (gone.length > 0) {
				result.missing += gone.length;
				for (const id of gone) {
					if (result.missingSample.length < sampleLimit)
						result.missingSample.push(id);
				}
				if (opts.reconcile) result.reconciled += await recopy(gone);
			}
			scanned += page.length;
			opts.onProgress?.(scanned, result.missing);
			page = [];
		};

		const recopy = async (ids: unknown[]): Promise<number> => {
			const docs = await srcCol
				.find({ _id: { $in: ids as never[] } })
				.toArray();
			for (const doc of docs) {
				// hot=false: é uma recópia fria, não pode mascarar o change stream.
				await writeDocToDest(destCol, doc, "verify:reconcile", false);
			}
			return docs.length;
		};

		const cursor = srcCol.find(filter ?? {}, { projection: { _id: 1 } });
		for await (const doc of cursor) {
			if (doc?._id == null) continue;
			page.push(doc._id);
			if (page.length >= batchSize) await checkPage();
		}
		await checkPage();

		return result;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		return result;
	}
}
