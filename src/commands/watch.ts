import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { eventHandler } from "../functions/documentFunctions";
import { getCollections } from "../functions/getCollections";
import type { WatchOptionsCli } from "../types/cliOptions";
import { watchYmlSchema, type WatchYmlOptions } from "../types/parseYml";
import parseYml from "../utils/parseYml";

export async function syncCollections(
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

		collections.forEach(async (collectionName) => {
			await eventHandler(collectionName, db, destDb);
		});
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
