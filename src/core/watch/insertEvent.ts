import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function insertEvent(
	collection: Collection,
	doc: Document,
	hash: string,
) {
	const collectionName = collection.namespace.split(".")[1];

	customLog("info", `Collection [ ${collectionName} ] Insert change detected`);
	if (!doc) {
		customLog(
			"warn",
			`[${collectionName}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}

	await collection.insertOne({
		...doc,
		hot: true,
		ts: Date.now(),
		hash: hash,
	});
	customLog("info", `[${collectionName}] Documento enviado para destino`);
}
