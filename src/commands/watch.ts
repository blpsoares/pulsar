import type { Db } from "mongodb";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { insertEvent } from "../core/watch/insertEvent";
import { updateEvent } from "../core/watch/updateEvent";
import { watchYmlSchema, type WatchYmlOptions } from "../types/parseYml";
import { customLog } from "../utils/customLog";
import { encodeDocument, eventOperation } from "../functions/documentFunctions";
import parseYml from "../utils/parseYml";
import { getCollections } from "../functions/getCollections";

export async function watchCollections(
	ymlPath: string,
	cliParams: WatchOptionsCli,
) {
	const options = parseYml<WatchYmlOptions>(ymlPath, watchYmlSchema);
	const client = await conn(options.command.watch.source.uri, "source");
	const db = client.db(options.command.watch.source.db);

	const destClient = await conn(
		options.command.watch.destination.uri,
		"destination",
	);

	const destDb = destClient.db(options.command.watch.destination.db);

	try {
		const collections = await getCollections(
			db,
			cliParams,
			ymlPath,
			options.command.watch.collections,
		);
		collections.forEach((collectionName) => {
			const collection = db.collection(collectionName);
			const destCollection = destDb.collection(collectionName);

			const changeStream = collection.watch([], {
				fullDocument: "updateLookup",
			});

			changeStream.on("change", async (change) => {
				customLog("info", `[${collectionName}] Change detected`);
				customLog("info", JSON.stringify(change));

				if (!eventOperation(change)) return;

				const doc = change.fullDocument;

				const hashDoc = encodeDocument(doc);
				if (change.operationType === "insert") {
					await insertEvent(destCollection, doc, hashDoc);
				} else if (change.operationType === "update") {
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
