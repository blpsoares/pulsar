import { crc32 } from "crc";
import type { ChangeStreamDocument, Document } from "mongodb";

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
	return crc32(JSON.stringify(document));
}
