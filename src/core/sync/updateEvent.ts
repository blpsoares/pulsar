import type { Document, Collection } from "mongodb";
import { customLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";

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
