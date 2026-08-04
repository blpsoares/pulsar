import { createHash } from "node:crypto";
import { BSON, type Document } from "mongodb";

//? Bring messages from collections that were not dumped/restored to this file (making the dump and restore functions cleaner)
export const MongoStatusReturns = (
	collectionsStats: MongoStatusReturn[],
	// message?: string,
): string[][] => {
	const successfulExports: string[] = [];
	const failedExports: string[] = [];
	const missingExports: string[] = [];
	collectionsStats.forEach((item) => {
		if (item.success) successfulExports.push(item.success);
		if (item.failed) failedExports.push(item.failed);
		if (item.missing) missingExports.push(item.missing);
	});

	return [successfulExports, failedExports, missingExports];
};

function encodeDocument(document: Document) {
	const hash = createHash("SHA-1");
	const hashedDocument = hash.update(BSON.serialize(document)).digest("hex");
	return hashedDocument;
}

/**
 * Metadados que o pulsar carimba em todo doc do destino. Tipado (e não
 * `Record<string, unknown>`) porque quem chama LÊ o hash de volta para comparar
 * com o destino — com o tipo frouxo, `newDocument.__sync?.hash` nem compilava.
 */
export type SyncMeta = { hot: boolean; ts: number; hash: string };

export type SyncedDocument = Document & {
	__sync: SyncMeta;
	origin?: string;
};

export function addFieldsOnMongoDocument(
	rawDocument: Document,
	origin?: string,
	hot: boolean = true,
): SyncedDocument {
	const hash = encodeDocument(rawDocument);
	const newDocument: SyncedDocument = {
		...rawDocument,
		__sync: {
			hot,
			ts: Date.now(),
			hash,
		},
	};

	if (origin) newDocument.origin = origin;
	return newDocument;
}

export const isHashEquals = <T>(hashOne: T, hashTwo: T) => hashOne === hashTwo;

export function transformFilterForChangeStream(filter: Document): Document {
	const result: Document = {};
	for (const [key, value] of Object.entries(filter)) {
		if (key.startsWith("$")) {
			result[key] = Array.isArray(value)
				? value.map((v) => transformFilterForChangeStream(v as Document))
				: transformFilterForChangeStream(value as Document);
		} else {
			result[`fullDocument.${key}`] = value;
		}
	}
	return result;
}
