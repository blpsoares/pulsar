import { ObjectId, type Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";

export async function watchDeleteEvent(
	_id: ObjectId,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { collectionName } = destCollection;

	let deletedCount: number;
	try {
		({ deletedCount } = await destCollection.deleteOne({ _id }));
	} catch (error) {
		customLog(
			"error",
			`watch:delete falhou | collection: ${collectionName} | _id: ${_id}`,
			false,
			error,
		);
		return;
	}

	if (!deletedCount) return;

	deletedIds.push(_id.toString());

	const msg = `watch:delete | collection: ${collectionName} | _id: ${_id}`;
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
