import { ObjectId, type Collection } from "mongodb";
import { customLog } from "../../utils/customLog";

export async function watchDeleteEvent(
	_id: ObjectId,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { deletedCount } = await destCollection.deleteOne({ _id });

	if (deletedCount) deletedIds.push(_id.toString());
	if (deletedCount) customLog("success", `Doc: ${_id.toString()} deletado.`); // !COMMIT
}
