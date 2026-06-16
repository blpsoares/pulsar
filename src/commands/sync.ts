/** biome-ignore-all assist/source/organizeImports: <explanation> */
import { eventHandler } from "../core/sync";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import type { SyncOptionsCli } from "../types/cliOptions";
import { syncYmlSchema, type SyncYmlOptions } from "../types/parseYml";
import parseYml from "../utils/parseYml";
import Bottleneck from "bottleneck";

export async function syncCollections(
	ymlPath: string,
	cliParams: SyncOptionsCli,
) {
	const options = parseYml<SyncYmlOptions>(ymlPath, syncYmlSchema);
	const client = await conn(options.command.sync.source.uri, "source");
	const db = client.db(options.command.sync.source.db);

	const destClient = await conn(
		options.command.sync.destination.uri,
		"destination",
	);

	const destDb = destClient.db(options.command.sync.destination.db);
	const limiter = new Bottleneck({ maxConcurrent: cliParams.parallel ?? 3 });

	try {
		const collections = await getCollections(
			db,
			cliParams,
			ymlPath,
			options.command.sync.collections,
		);

		collections.forEach(({ name, filter }) => {
			limiter.schedule(() => eventHandler(name, db, destDb, filter));
		});
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
