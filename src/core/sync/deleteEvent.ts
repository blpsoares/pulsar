import { ObjectId, type Collection } from "mongodb";
import { customLog, logger } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";

export async function watchDeleteEvent(
	_id: ObjectId,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { collectionName } = destCollection;
	const { deletedCount } = await destCollection.deleteOne({ _id });

	if (!deletedCount) return;

	deletedIds.push(_id.toString());

	const msg = `[${collectionName}] delete | _id: ${_id}`;
	logger.info(msg);
	if (getLogConfig().verbose) customLog("info", msg);
}
