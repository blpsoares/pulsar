import type { Document, Collection } from "mongodb";
import { customLog, logger } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchUpdateEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] update: fullDocument não encontrado. Ignorando.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:update");
	await destCollection.updateOne({ _id: rawDocument._id }, { $set: newDocument }, { upsert: true });

	const msg = `[${collectionName}] update | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) customLog("info", msg);
}
