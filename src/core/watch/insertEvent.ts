import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function insertEvent(
	collection: Collection,
	doc: Document,
	hash: number,
) {
	if (!doc) {
		customLog(
			"warn",
			`[${collection.namespace}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}

	await collection.insertOne({
		...doc,
		hot: true,
		ts: Date.now(),
		hash: hash,
	});
	console.log(`[${collection.namespace}] Documento enviado para destino`);
}
