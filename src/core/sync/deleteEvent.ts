import type { ChangeStreamDeleteDocument, Collection, ObjectId } from "mongodb";
import { watcher } from "./watcherEvents";

export async function watchDeleteEvent(
	destCollection: Collection,
	_id: ObjectId,
	deletedIds: ObjectId[],
) {
	const { deletedCount } = await destCollection.deleteOne({ _id });
	if (deletedCount) deletedIds.push(_id);
}

export function deleteFn(doc: ChangeStreamDeleteDocument, coll: Collection) {
	const deletedIds: string[] = [];
	watcher.emit("delete", coll, doc.documentKey._id, deletedIds);
}
