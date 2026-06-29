import type { Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";

/**
 * Pipeline de update que:
 * 1. Substitui o doc do destino pela versão da origem (com __sync/origin) —
 *    semântica de REPLACE, então campo removido na origem some no destino.
 * 2. Grava __migratedAt como BSON Date na 1ª vez e PRESERVA nas demais
 *    (`$ifNull`). `$$NOW` é a data do servidor (BSON Date).
 * `$literal` embrulha o doc pra valores como "$x"/"R$ 5" NÃO virarem expressão.
 */
export function buildReplaceWithMigratedAt(docWithMeta: Document): Document[] {
	return [
		{
			$replaceWith: {
				$mergeObjects: [
					{ $literal: docWithMeta },
					{ __migratedAt: { $ifNull: ["$__migratedAt", "$$NOW"] } },
				],
			},
		},
	];
}

/**
 * Escreve um doc da origem no destino (replace + __migratedAt imutável). Usado
 * pelos handlers do watch (1-a-1); o dump usa o MESMO pipeline em bulkWrite.
 */
export async function writeDocToDest(
	destCol: Collection,
	sourceDoc: Document,
	origin: string,
	hot = true,
): Promise<void> {
	const docWithMeta = addFieldsOnMongoDocument(sourceDoc, origin, hot);
	await destCol.updateOne(
		{ _id: sourceDoc._id },
		buildReplaceWithMigratedAt(docWithMeta),
		{ upsert: true },
	);
}
