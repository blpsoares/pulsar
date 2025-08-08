import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function insertEvent(collection: Collection, doc: Document) {
	if (!doc) {
		customLog(
			"warn",
			`[${collection}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	await collection.insertOne(doc);
	console.log(`[${collection}] Documento enviado para destino`);
}
