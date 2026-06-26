import type { Collection, Document } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchReplaceEvent(
	destCollection: Collection,
	rawDocument: Document,
) {
	const { collectionName } = destCollection;
	if (!rawDocument) {
		customLog(
			"warn",
			`[${collectionName}] replace: fullDocument not found, skipping.`,
		);
		return;
	}

	try {
		await writeDocToDest(destCollection, rawDocument, "watch:replace");
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
