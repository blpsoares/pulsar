import { conn } from "../db/conn";
import parseYml from "../utils/parseYml";
import { errorHandler } from "../errors/errorHandler";
import type { Db } from "mongodb";
import { watchYmlSchema, type WatchYmlOptions } from "../types/parseYml";
import { customLog } from "../utils/customLog";
import { insertEvent } from "../operations/watch/insertEvent";
import { updateEvent } from "../operations/watch/updateEvent";

export async function getCollections(
	db: Db,
	cliParams: WatchOptionsCli,
	options: WatchYmlOptions,
	ymlpath: string,
) {
	let collections: string[] = [];
	if (cliParams.all) {
		collections = (await db.listCollections().toArray()).map(
			(collection) => collection.name,
		);
	} else if (options.command.watch.collections) {
		collections = options.command.watch.collections;
	} else {
		throw errorHandler(
			new Error(`No collections to watch on file: ${ymlpath}`),
		);
	}
	return collections;
}

export async function watchCollections(
	ymlpath: string,
	cliParams: WatchOptionsCli,
) {
	const options = parseYml<WatchYmlOptions>(ymlpath, watchYmlSchema);
	const client = await conn(options.command.watch.source.uri, "source");
	const db = client.db(options.command.watch.source.db);

	const destClient = await conn(
		options.command.watch.destination.uri,
		"destination",
	);

	const destDb = destClient.db(options.command.watch.destination.db);

	try {
		const collections = await getCollections(db, cliParams, options, ymlpath);
		collections.forEach((collectionName) => {
			const collection = db.collection(collectionName);
			const destCollection = destDb.collection(collectionName);

			const changeStream = collection.watch([], {
				fullDocument: "updateLookup",
			});

			changeStream.on("change", async (change) => {
				customLog("info", `[${collectionName}] Change detected`);
				customLog("info", JSON.stringify(change));

				if (change.operationType === "insert") {
					const doc = change.fullDocument;
					await insertEvent(destCollection, doc);
				} else if (change.operationType === "update") {
					const doc = change.fullDocument;
					if (!doc) return;
					await updateEvent(destCollection, doc);
				}
			});
			changeStream.on("error", (err) => {
				customLog("error", err);
			});

			changeStream.on("close", () => {
				customLog("info", "Change stream closed");
			});
		});
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
