/** biome-ignore-all assist/source/organizeImports: <explanation> */
import { eventHandler, acceptableEventOperations } from "../core/sync";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import type { SyncOptionsCli } from "../types/cliOptions";
import { syncYmlSchema, type SyncYmlOptions } from "../types/parseYml";
import parseYml from "../utils/parseYml";
import { setLogConfig } from "../utils/logConfig";
import { customLog } from "../utils/customLog";
import { initProgress } from "../utils/progressManager";
import Bottleneck from "bottleneck";

export async function syncCollections(
	ymlPath: string,
	cliParams: SyncOptionsCli,
) {
	const options = parseYml<SyncYmlOptions>(ymlPath, syncYmlSchema);

	const ymlLogging = options.command.sync.logging ?? {};
	setLogConfig({
		verbose: cliParams.verbose ?? ymlLogging.verbose ?? false,
		progress: ymlLogging.progress ?? true,
	});

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

		initProgress(collections.length);

		const jobs = collections.map(({ name, filter }) =>
			limiter.schedule(() => eventHandler(name, db, destDb, filter)),
		);

		await Promise.all(jobs);

		customLog(
			"info",
			`Initial sync done. Watching ${collections.length} collection(s) for live changes — events: ${acceptableEventOperations.join(", ")}`,
			true,
		);
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
