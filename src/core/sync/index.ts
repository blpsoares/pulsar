// biome-ignore assist/source/organizeImports: <explanation>

import type { ChangeStreamDocument, Collection, Db, ObjectId } from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { watcher } from "./watcherEvents";
import { errorHandler } from "../../errors/errorHandler";
import { customLog } from "../../utils/customLog";

export const acceptableEventOperations = [
	"insert",
	"update",
	"delete",
	"replace",
];

const deletedIds: string[] = [];

export async function eventHandler(
	collectionName: string,
	sourceDb: Db,
	destDb: Db,
) {
	const sourceCollection = sourceDb.collection(collectionName);
	const destCollection = destDb.collection(collectionName);

	await freezeCollection(destCollection);
	watchCollections(sourceCollection, destCollection);
}

export async function watchCollections(
	sourceCollection: Collection,
	destCollection: Collection,
) {
	const changeStream = sourceCollection.watch([], {
		fullDocument: "updateLookup",
	});

	changeStream.on("change", (change) => {
		customLog("debug", "INICIANDO WATCH");
		delegateEvent(change, destCollection, deletedIds);
	});

	customLog("debug", "INICIANDO DUMP");
	watcher.emit("dump", sourceCollection, destCollection, deletedIds);

	changeStream.on("error", errorHandler);
}

function delegateEvent(
	change: ChangeStreamDocument,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { operationType } = change;
	switch (operationType) {
		case "insert":
			watcher.emit("insert", destCollection, change.fullDocument);
			break;
		case "update":
			watcher.emit("update", destCollection, change.fullDocument);
			break;
		case "delete":
			watcher.emit(
				"delete",
				change.documentKey._id,
				destCollection,
				deletedIds,
			);
			break;
		default:
			break;
	}
}
