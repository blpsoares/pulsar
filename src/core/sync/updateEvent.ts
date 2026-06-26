import type { Collection, Document } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchUpdateEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog(
			"warn",
			`[${collectionName}] update: fullDocument not found, skipping.`,
		);
		return;
	}

	try {
		await writeDocToDest(destCollection, rawDocument, "watch:update");
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
