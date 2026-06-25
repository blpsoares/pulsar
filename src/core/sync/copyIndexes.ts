// src/core/sync/copyIndexes.ts
import type { Collection, Document } from "mongodb";

export type IndexCopyResult = {
	created: number;
	skipped: number;
	failed: { name: string; reason: string }[];
	createdNames: string[];
};

// Campos meta do listIndexes que NÃO entram nem na assinatura nem nas opções de
// createIndex (versões internas variam por versão de servidor e gerariam falso
// "faltando" → conflito de nome).
const STRIP = new Set([
	"v",
	"key",
	"name",
	"ns",
	"background",
	"textIndexVersion",
	"2dsphereIndexVersion",
]);

/** Opções de um índice (unique, sparse, partial, collation, expireAfterSeconds,
 *  weights, default_language, wildcardProjection...), sem os campos meta. */
function indexOptions(idx: Document): Record<string, unknown> {
	const opts: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(idx)) {
		if (!STRIP.has(k)) opts[k] = val;
	}
	return opts;
}

/** JSON canônico (chaves ordenadas recursivamente) p/ comparar índices por valor. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys
		.map(
			(k) =>
				`${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
		)
		.join(",")}}`;
}

/** Assinatura = key + opções (ignora nome/versões) → equivalentes batem mesmo
 *  com nomes diferentes.
 *  A ordem dos campos do `key` é SIGNIFICATIVA em índice composto
 *  ({a:1,b:1} != {b:1,a:1}), então o key é serializado preservando a ordem de
 *  inserção (JSON.stringify, não stableStringify). As opções são
 *  order-insensitive → canonicalizadas por stableStringify. */
function signature(idx: Document): string {
	return `${JSON.stringify(idx.key)}|${stableStringify(indexOptions(idx))}`;
}

/**
 * Garante no destino os índices secundários da origem. Faz um diff por
 * assinatura: cria SÓ os que faltam. Erro de `createIndex` é contido por-índice
 * (entra em `failed`). `srcCol.listIndexes()` falhando propaga (chamador trata a
 * collection inteira); `destCol.listIndexes()` falhando → não cria nada.
 */
export async function ensureCollectionIndexes(
	srcCol: Collection,
	destCol: Collection,
): Promise<IndexCopyResult> {
	const result: IndexCopyResult = {
		created: 0,
		skipped: 0,
		failed: [],
		createdNames: [],
	};

	// Origem: se isto falhar, propaga (a collection inteira vira falha no engine).
	const srcIdx = (await srcCol.listIndexes().toArray()).filter(
		(i) => i.name !== "_id_",
	);
	if (srcIdx.length === 0) return result;

	// Destino: lista os índices existentes pra montar o diff.
	let destSigs: Set<string>;
	try {
		const destIdx = await destCol.listIndexes().toArray();
		destSigs = new Set(destIdx.map(signature));
	} catch (err) {
		// NamespaceNotFound (26): a collection ainda NÃO existe no destino (ex.:
		// vazia na origem → o dump não materializou nada). Não é falha — significa
		// "nenhum índice lá" → cria todos (o createIndex cria a collection junto).
		// Qualquer OUTRO erro: não dá pra diferenciar com segurança → não cria nada.
		if ((err as { code?: number })?.code === 26) {
			destSigs = new Set();
		} else {
			const reason = err instanceof Error ? err.message : String(err);
			result.failed.push({ name: "*listIndexes(dest)", reason });
			return result;
		}
	}

	for (const idx of srcIdx) {
		if (destSigs.has(signature(idx))) {
			result.skipped += 1;
			continue;
		}
		try {
			await destCol.createIndex(idx.key as Document, {
				name: idx.name as string,
				...indexOptions(idx),
			});
			result.created += 1;
			result.createdNames.push(idx.name as string);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.failed.push({ name: idx.name as string, reason });
		}
	}
	return result;
}
