import type { Document, Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchUpdateEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] update: fullDocument not found, skipping.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:update");

	try {
		await destCollection.updateOne({ _id: rawDocument._id }, { $set: newDocument }, { upsert: true });
	} catch (error) {
		customLog(
			"error",
			`watch:update falhou | collection: ${collectionName} | _id: ${rawDocument._id}`,
			false,
			error,
		);
		return;
	}

	const msg = `watch:update | collection: ${collectionName} | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
