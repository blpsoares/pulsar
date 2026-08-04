import type { Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { t } from "../../utils/i18n";
import { idKey } from "../../utils/idKey";
import { getLogConfig } from "../../utils/logConfig";

export async function watchDeleteEvent(
	_id: unknown,
	destCollection: Collection,
	deletedKeys: Set<string>,
) {
	const { collectionName } = destCollection;

	let deletedCount: number;
	try {
		({ deletedCount } = await destCollection.deleteOne({ _id: _id as never }));
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

	deletedKeys.add(idKey(_id));

	const msg = t("watch.delete", { coll: collectionName, id: String(_id) });
	logger.info(msg);
	if (getLogConfig().verbose) terminalLog("info", msg);
}
