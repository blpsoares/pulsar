import type { Db } from "mongodb";
import { deriveCreated } from "./deriveCreated";
import type { ResolvedTtl } from "./resolveTtlEntry";

export type TtlResult = {
	name: string;
	field: string;
	expireAfterSeconds: number;
	derivedCount?: number;
	indexName: string;
};

/**
 * Aplica o TTL numa collection já resolvida: se deriveFromId, materializa o
 * campo _created a partir do _id; depois cria o índice TTL no campo.
 */
export async function applyTtl(db: Db, resolved: ResolvedTtl): Promise<TtlResult> {
	let derivedCount: number | undefined;
	if (resolved.deriveFromId) {
		derivedCount = await deriveCreated(db, resolved.name, resolved.field);
	}

	const indexName = await db
		.collection(resolved.name)
		.createIndex({ [resolved.field]: 1 }, { expireAfterSeconds: resolved.expireAfterSeconds });

	return {
		name: resolved.name,
		field: resolved.field,
		expireAfterSeconds: resolved.expireAfterSeconds,
		derivedCount,
		indexName,
	};
}
