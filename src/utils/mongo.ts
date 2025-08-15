// TODO:

import { BSON, type Document } from "mongodb";
import { createHash } from "node:crypto";

//? Bring messages from collections that were not dumped/restored to this file (making the dump and restore functions cleaner)
export const MongoStatusReturns = (
	collectionsStats: MongoStatusReturn[],
	// message?: string,
): string[][] => {
	const successfulExports: string[] = [];
	const failedExports: string[] = [];
	collectionsStats.forEach((item) => {
		if (item.success) successfulExports.push(item.success);
		if (item.failed) failedExports.push(item.failed);
	});

	return [successfulExports, failedExports];
};

function encodeDocument(document: Document) {
	const hash = createHash("SHA-1");
	const hashedDocument = hash.update(BSON.serialize(document)).digest("hex");
	return hashedDocument;
}

export function addFieldsOnMongoDocument(
	rawDocument: Document,
	origin?: string,
	hot: boolean = true,
) {
	const hash = encodeDocument(rawDocument);
	const newDocument: Record<string, any> = {
		...rawDocument,
		hot,
		ts: Date.now(),
		hash,
	};

	if (origin) newDocument.origin = origin;
	return newDocument;
}

export const isHashEquals = <T>(hashOne: T, hashTwo: T) => hashOne === hashTwo;
