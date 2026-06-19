import type { Document } from "mongodb";
import { transformFilterForChangeStream } from "../../utils/mongo";

export type WatchedCollection = { name: string; filter?: Document };

/**
 * Monta o pipeline de um ÚNICO change stream no banco (`db.watch`) recortado
 * apenas nas collections configuradas — assim 1 conexão escuta as X collections
 * (em vez de 1 conexão por collection), e o servidor só manda o que interessa.
 *
 * - collection sem filtro → `{ "ns.coll": name }` (qualquer operação).
 * - collection com filtro → delete sempre passa (sem fullDocument pra casar) e
 *   as demais operações precisam casar o filtro nos campos de `fullDocument`.
 */
export function buildDbWatchPipeline(
	collections: WatchedCollection[],
): Document[] {
	const clauses: Document[] = [];
	for (const { name, filter } of collections) {
		if (!filter) {
			clauses.push({ "ns.coll": name });
		} else {
			clauses.push({ "ns.coll": name, operationType: "delete" });
			clauses.push({
				"ns.coll": name,
				...transformFilterForChangeStream(filter),
			});
		}
	}
	if (clauses.length === 0) return [];
	return [{ $match: { $or: clauses } }];
}
