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
 *  com nomes diferentes. */
function signature(idx: Document): string {
	return stableStringify({ key: idx.key, ...indexOptions(idx) });
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

	// Destino: se falhar, não dá pra diferenciar com segurança → não cria nada.
	let destSigs: Set<string>;
	try {
		const destIdx = await destCol.listIndexes().toArray();
		destSigs = new Set(destIdx.map(signature));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		result.failed.push({ name: "*listIndexes(dest)", reason });
		return result;
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
