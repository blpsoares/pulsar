import type { Collection, Document } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchInsertEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog(
			"warn",
			`[${collectionName}] insert: fullDocument not found, skipping.`,
		);
		return;
	}

	try {
		await writeDocToDest(destCollection, rawDocument, "watch:insert");
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
