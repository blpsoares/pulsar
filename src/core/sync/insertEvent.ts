import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";

export async function watchInsertEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const destCollectionName = destCollection.namespace.split(".")[1];
	if (!rawDocument) {
		customLog(
			"warn",
			`[${destCollectionName}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:insert");
	await destCollection.insertOne(newDocument);
}
