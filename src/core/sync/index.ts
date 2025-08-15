// biome-ignore assist/source/organizeImports: <explanation>

import type { ChangeStreamDocument, Collection, Db } from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { watcher } from "./watcherEvents";
import { errorHandler } from "../../errors/errorHandler";
import { insertFn } from "./insertEvent";
import { deleteFn } from "./deleteEvent";
import { updateFn } from "./updateEvent";

export const acceptableEventOperations = [
	"insert",
	"update",
	"delete",
	"replace",
];

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

	watcher.emit("dump", sourceCollection, destCollection);
	changeStream.on("change", delegateEvent);

	changeStream.on("error", errorHandler);
}

const eventMap: Record<string, Function> = {
	insertFn,
	updateFn,
	deleteFn,
};

export function delegateEvent(
	change: ChangeStreamDocument,
	destCollection: Collection,
) {
	const eventHandler = eventMap[change.operationType.concat("Fn")];
	if (eventHandler) eventHandler(change, destCollection);
}
