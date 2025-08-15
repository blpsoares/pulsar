import type { Document, Collection, ChangeStreamInsertDocument } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { watcher } from "./watcherEvents";

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

export function insertFn(doc: ChangeStreamInsertDocument, coll: Collection) {
	watcher.emit("insert", coll, doc.fullDocument);
}
