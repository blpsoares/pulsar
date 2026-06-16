import type { Collection, Document } from "mongodb";
import { customLog, logger } from "../../utils/customLog";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { getLogConfig } from "../../utils/logConfig";

export async function watchReplaceEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog("warn", `[${collectionName}] replace: fullDocument não encontrado. Ignorando.`);
		return;
	}

	const newDocument = addFieldsOnMongoDocument(rawDocument, "watch:replace");
	await destCollection.replaceOne({ _id: rawDocument._id }, newDocument);

	const msg = `[${collectionName}] replace | _id: ${rawDocument._id}`;
	logger.info(msg);
	if (getLogConfig().verbose) customLog("info", msg);
}
