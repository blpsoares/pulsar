import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongoToolsReturn";

export async function updateEvent(collection: Collection, doc: Document) {
	if (!doc) {
		customLog(
			"warn",
			`[${collection.namespace}] fullDocument não encontrado. Ignorando.`,
		);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(doc, "watch:update");

	await collection.updateOne(
		{ _id: doc._id },
		{
			$set: newDocument,
		},
		{ upsert: true },
	);
}
