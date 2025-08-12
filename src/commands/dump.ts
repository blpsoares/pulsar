import fs from "fs";
import path from "path";
import { conn } from "../db/conn";
import Bottleneck from "bottleneck";
import parseYml from "../utils/parseYml";
import { initDump } from "../core/dump/dump";
import { deleteTempFolder } from "../utils/deleteTempFolder";
import { initRestore } from "../core/dump/restoreDump";
import { initRegistrationSync } from "../core/dump/initSync";
import { dropOldCollections } from "../core/dump/dropOldCollections";
import { renameNewCollections } from "../core/dump/renameCollections";
import { customLog } from "../utils/customLog";
import { dumpYmlSchema, type DumpYmlOptions } from "../types/parseYml";
import { getCollections } from "../functions/getCollections";
import type { DumpOptionsCli } from "../types/cliOptions";

const migrateCollections = async (
	ymlPath: string,
	cliParams: DumpOptionsCli,
) => {
	const outputExport = path.resolve(__dirname, "..", "..", "temp-dump");

	if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);
	const options = parseYml<DumpYmlOptions>(ymlPath, dumpYmlSchema);
	const { dump } = options.command;
	const limiter = new Bottleneck({ maxConcurrent: cliParams.parallel ?? 2 });

	const clientSource = await conn(dump.source.uri, "source");
	const dbSource = clientSource.db(dump.source.db);
	const dumpCollections = await getCollections(
		dbSource,
		cliParams,
		ymlPath,
		dump.collections,
	);
	/**
	 *
	 * ? DUMP COLLECTIONS
	 */
	const successExports = await initDump(
		dump.source,
		outputExport,
		limiter,
		dumpCollections,
		dump.queryString,
		cliParams.maxRetries,
	);

	/**
	 *
	 * ? RESTORE COLLECTIONS
	 */
	const [successRestores, failedRestores] = await initRestore(
		options,
		successExports,
		limiter,
		cliParams.maxRetries,
	);

	if (failedRestores.length > 0) {
		customLog("error", `Failed to restore collections: ${failedRestores}`);
		return;
	}

	/**
	 *
	 * ? CONNECT TO DESTINATION
	 */
	const client = await conn(dump.destination.uri, "destination");

	/**
	 *
	 * ? SET STATE ON __sync COLLECTION
	 */
	const [successColds, failedColds] = await initRegistrationSync(
		options,
		successRestores,
		client,
		limiter,
	);

	if (failedColds.length > 0) {
		customLog("info", "Retrying set cold stats on failed collections");

		let [newSuccessColds] = await initRegistrationSync(
			options,
			failedColds,
			client,
			limiter,
		);
		successColds.push(...newSuccessColds);
	}

	/**
	 *
	 * ? DROP ON DATABASE ALL COLLECTIONS DUMPED
	 */
	const [successDrops, failedDrops] = await dropOldCollections(
		client,
		dump.destination.db,
		successColds,
		limiter,
	);
	if (failedDrops.length > 0) {
		customLog("info", "Retrying drop failed collections");

		const [newSuccessDrops] = await dropOldCollections(
			client,
			dump.destination.db,
			failedDrops,
			limiter,
		);
		successDrops.push(...newSuccessDrops);
	}

	/**
	 *
	 * ? REMOVE ON DESTINATION DATABASE ALL _dump_ PREFIX ON RESTORED COLLECTIONS
	 */
	await renameNewCollections(
		client,
		dump.destination.db,
		successDrops,
		limiter,
	);

	/**
	 *
	 * ? CLEAN LOCAL REGISTRES (GENERATED FOR dumpCollections)
	 */
	deleteTempFolder(outputExport);

	/**
	 *
	 * ? CLOSE MONGODB CONNECTION
	 */
	client.close();
};

export default migrateCollections;
