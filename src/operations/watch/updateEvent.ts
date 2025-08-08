import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function updateEvent(collection: Collection, doc: Document) {
	if (!doc) {
		customLog(
			"warn",
			`[${collection}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	await collection.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });

	console.log(`[${collection}] Documento enviado para destino`);
}
