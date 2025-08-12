import {
	BSON,
	Collection,
	Db,
	type ChangeStreamDocument,
	type Document,
} from "mongodb";
import { createHash } from "node:crypto";
import { insertEvent } from "../core/watch/insertEvent";
import { updateEvent } from "../core/watch/updateEvent";
import { errorHandler } from "../errors/errorHandler";
import { customLog } from "../utils/customLog";
import { freezeCollection } from "./freeze";

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

export async function eventHandler(collectionName: string, db: Db, destDb: Db) {
	const collection = db.collection(collectionName);
	const destCollection = destDb.collection(collectionName);
	await freezeCollection(destCollection);

	const changeStream = collection.watch([], {
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
