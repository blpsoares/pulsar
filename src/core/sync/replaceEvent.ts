import type { Collection, Document } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchReplaceEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] replace: fullDocument not found, skipping.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:replace");

	try {
		// upsert para cobrir o caso em que o doc ainda não chegou ao destino
		// (corrida com o dump).
		await destCollection.replaceOne({ _id: rawDocument._id }, newDocument, {
			upsert: true,
		});
	} catch (error) {
		customLog(
			"error",
			`watch:replace falhou | collection: ${collectionName} | _id: ${rawDocument._id}`,
			false,
			error,
		);
		return;
	}

	const msg = `watch:replace | collection: ${collectionName} | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
