import {
	BSON,
	Collection,
	Db,
	type ChangeStreamDocument,
	type Document,
} from "mongodb";
import { createHash } from "node:crypto";
import { insertEvent } from "../core/sync/insertEvent";
import { updateEvent } from "../core/sync/updateEvent";
import { errorHandler } from "../errors/errorHandler";
import { freezeCollection } from "./freeze";
import { dumpEvent } from "./dumpEvent";

export function eventOperation<T extends Document>(
	change: ChangeStreamDocument<T>,
): change is ChangeStreamDocument<T> & { fullDocument: T } {
	return (
		change.operationType === "insert" ||
		change.operationType === "update" ||
		change.operationType === "replace"
	);
}

export function encodeDocument(document: Document) {
	const hash = createHash("SHA-1");
	const hashedDocument = hash.update(BSON.serialize(document)).digest("hex");
	return hashedDocument;
}

export const isHashEquals = <T>(hashOne: T, hashTwo: T) => hashOne === hashTwo;

export type triggerEventFunction = (
	collection: Collection,
	doc: Document,
	hashDoc: string,
) => Promise<void>;

const triggerEvent: Partial<
	Record<ChangeStreamDocument["operationType"], triggerEventFunction>
> = {
	insert: insertEvent,
	update: updateEvent,
};

export async function eventHandler(
	collectionName: string,
	sourceDb: Db,
	destDb: Db,
) {
	const sourceCollection = sourceDb.collection(collectionName);
	const destCollection = destDb.collection(collectionName);
	await freezeCollection(destCollection);

	dumpEvent.emit("dump", sourceCollection, destCollection);
	watchCollections(sourceCollection, destCollection);
}

export async function watchCollections(
	sourceCollection: Collection,
	destCollection: Collection,
) {
	const changeStream = sourceCollection.watch([], {
		fullDocument: "updateLookup",
	});

	changeStream.on("change", async (change) => {
		if (!eventOperation(change)) return;
		const doc = change.fullDocument;
		const hashDoc = encodeDocument(doc);

		const handler = triggerEvent[change.operationType];
		if (handler) await handler(destCollection, doc, hashDoc);
	});

	changeStream.on("error", errorHandler);
}
