import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function updateEvent(
	collection: Collection,
	doc: Document,
	hash: string,
) {
	if (!doc) {
		customLog(
			"warn",
			`[${collection.namespace}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	await collection.updateOne(
		{ _id: doc._id },
		{ $set: { ...doc, hot: true, ts: Date.now(), hash } },
		{ upsert: true },
	);

	console.log(`[${collection.namespace}] Documento enviado para destino`);
}
