import type { Document } from "mongodb";

export type WatchedCollection = { name: string; filter?: Document };

/**
 * Pipeline do change stream único (`db.watch`) na Fase 2: o evento é só GATILHO.
 * - `$match` recorta nas X collections por `ns.coll` (qualquer operação). O
 *   filtro por collection NÃO entra aqui — ele é aplicado na re-busca (o engine
 *   faz `find({ $and: [{_id:{$in}}, filter] })`), então um update que tira o doc
 *   do filtro também é detectado (vira delete no destino).
 * - `$project` REMOVE `fullDocument` e `updateDescription` → o evento nunca
 *   carrega o documento, logo nunca passa de 16MB. O stream é aberto SEM
 *   `updateLookup` (no engine), então `fullDocument` nem é montado.
 */
export function buildDbWatchPipeline(
	collections: WatchedCollection[],
): Document[] {
	const clauses: Document[] = collections.map(({ name }) => ({
		"ns.coll": name,
	}));
	if (clauses.length === 0) return [];
	return [
		{ $match: { $or: clauses } },
		{ $project: { fullDocument: 0, updateDescription: 0 } },
	];
}
