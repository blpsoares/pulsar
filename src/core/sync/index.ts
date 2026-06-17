// biome-ignore assist/source/organizeImports: <explanation>

import type { ChangeStreamDocument, Collection, Db, Document } from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { dumpCollections } from "./dumpEvent";
import { watcher } from "./watcherEvents";
import { errorHandler } from "../../errors/errorHandler";
import { transformFilterForChangeStream } from "../../utils/mongo";

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
	filter?: Document,
) {
	const sourceCollection = sourceDb.collection(collectionName);
	const destCollection = destDb.collection(collectionName);

	await freezeCollection(destCollection);
	await watchCollections(sourceCollection, destCollection, filter);
}

export async function watchCollections(
	sourceCollection: Collection,
	destCollection: Collection,
	filter?: Document,
) {
	const pipeline = filter
		? [{ $match: { $or: [{ operationType: "delete" }, transformFilterForChangeStream(filter)] } }]
		: [];

	const changeStream = sourceCollection.watch(pipeline, {
		fullDocument: "updateLookup",
	});

	changeStream.on("change", (change) => {
		delegateEvent(change, destCollection, deletedIds);
	});

	changeStream.on("error", errorHandler);

	await dumpCollections(sourceCollection, destCollection, deletedIds, filter);
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
		case "replace":
			watcher.emit("replace", destCollection, change.fullDocument);
			break;
		default:
			break;
	}
}
