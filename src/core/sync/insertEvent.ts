import type { Document, Collection } from "mongodb";
import { customLog, logger } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchInsertEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] insert: fullDocument não encontrado. Ignorando.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:insert");
	await destCollection.insertOne(newDocument);

	const msg = `[${collectionName}] insert | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) customLog("info", msg);
}
