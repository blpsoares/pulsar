import type { ChangeStreamDocument, Document } from "mongodb";

export function docValidation<T extends Document>(
	change: ChangeStreamDocument<T>,
): change is ChangeStreamDocument<T> & { fullDocument: T } {
	return (
		change.operationType === "insert" ||
		change.operationType === "update" ||
		change.operationType === "replace"
	);
}
