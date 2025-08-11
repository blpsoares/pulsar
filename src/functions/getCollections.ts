import type { Db } from "mongodb";
import { errorHandler } from "../errors/errorHandler";

export async function getCollections<T extends { all?: boolean }>(
	db: Db,
	cliParams: T,
	ymlPath: string,
	collections?: string[],
) {
	let finalCollections: string[] = [];
	if (cliParams.all) {
		finalCollections = (await db.listCollections().toArray()).map(
			(collection) => collection.name,
		);
	} else if (collections) {
		finalCollections = collections;
	} else {
		throw errorHandler(
			new Error(`No collections to watch on file: ${ymlPath}`),
		);
	}
	return finalCollections;
}
