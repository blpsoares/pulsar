import type { Document, Collection, ChangeStreamUpdateDocument } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { watcher } from "./watcherEvents";

export async function watchUpdateEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	if (!rawDocument) {
		customLog(
			"warn",
			`[${destCollection.namespace}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}
	customLog("info", "updatado papi");

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:update");

	await destCollection.updateOne(
		{ _id: rawDocument._id },
		{
			$set: newDocument,
		},
		{ upsert: true },
	);
}

export function updateFn(doc: ChangeStreamUpdateDocument, coll: Collection) {
	watcher.emit("update", coll, doc.fullDocument);
}
