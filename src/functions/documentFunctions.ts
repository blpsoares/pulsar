import { createHash } from "node:crypto";
import { BSON, type ChangeStreamDocument, type Document } from "mongodb";

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
  const hashedDocument = hash.update(BSON.serialize(document))
  return hashedDocument;
	// return crc32(JSON.stringify(document));
}