import type { Db } from "mongodb";
import { DERIVED_FIELD } from "./resolveTtlEntry";

/**
 * Materializa um campo Date a partir do timestamp embutido no _id (ObjectId),
 * via updateMany com pipeline ($toDate). Só toca docs que ainda não têm o campo
 * (idempotente). Retorna a quantidade de docs modificados.
 *
 * Necessário porque TTL só funciona em campo BSON Date; _id (ObjectId) não expira.
 * One-shot sobre os docs existentes — inserts futuros não são cobertos aqui.
 */
export async function deriveCreated(
	db: Db,
	collection: string,
	field: string = DERIVED_FIELD,
): Promise<number> {
	const res = await db.collection(collection).updateMany({ [field]: { $exists: false } }, [
		{ $set: { [field]: { $toDate: "$_id" } } },
	]);
	return res.modifiedCount;
}
