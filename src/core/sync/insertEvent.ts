import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongoToolsReturn";

export async function insertEvent(collection: Collection, doc: Document) {
	const collectionName = collection.namespace.split(".")[1];
	if (!doc) {
		customLog(
			"warn",
			`[${collectionName}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	const newDocument = addFieldsOnMongoDocument(doc, "watch:insert");
	await collection.insertOne(newDocument);
}
