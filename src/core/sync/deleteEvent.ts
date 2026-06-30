import type { Collection, ObjectId } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { t } from "../../utils/i18n";
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
			t("watch.delete_failed", { coll: collectionName, id: String(_id) }),
			false,
			error,
		);
		return;
	}

	if (!deletedCount) return;

	deletedIds.push(_id.toString());

	const msg = t("watch.delete", { coll: collectionName, id: String(_id) });
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
