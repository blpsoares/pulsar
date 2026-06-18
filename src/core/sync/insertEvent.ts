import type { Document, Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchInsertEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] insert: fullDocument not found, skipping.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:insert");

	try {
		// upsert (não insertOne) para ser idempotente: o doc pode já existir por
		// causa da corrida entre dump e change stream ou de entrega duplicada do
		// evento. insertOne nesse caso lança E11000 e derrubaria o processo.
		await destCollection.replaceOne({ _id: rawDocument._id }, newDocument, {
			upsert: true,
		});
	} catch (error) {
		customLog(
			"error",
			`watch:insert falhou | collection: ${collectionName} | _id: ${rawDocument._id}`,
			false,
			error,
		);
		return;
	}

	const msg = `watch:insert | collection: ${collectionName} | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
