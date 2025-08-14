// TODO:

import type { Document } from "mongodb";
import { encodeDocument } from "../functions/documentFunctions";

//? Bring messages from collections that were not dumped/restored to this file (making the dump and restore functions cleaner)
export const MongoStatusReturns = (
	collectionsStats: MongoStatusReturn[],
	message?: string,
): string[][] => {
	const successfulExports: string[] = [];
	const failedExports: string[] = [];
	collectionsStats.forEach((item) => {
		if (item.success) successfulExports.push(item.success);
		if (item.failed) failedExports.push(item.failed);
	});

	return [successfulExports, failedExports];
};

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
