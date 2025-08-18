import fs from "fs";
import path from "path";
import { conn } from "../db/conn";
import Bottleneck from "bottleneck";
import parseYml from "../utils/parseYml";
import { initMigration } from "../core/dump/dump";
import { deleteTempFolder } from "../utils/deleteTempFolder";
import { initRestore } from "../core/dump/restoreDump";
import { initRegistrationSync } from "../core/dump/initSync";
import { dropOldCollections } from "../core/dump/dropOldCollections";
import { renameNewCollections } from "../core/dump/renameCollections";
import { customLog } from "../utils/customLog";
import { migrateYmlSchema, type MigrateYmlOptions } from "../types/parseYml";
import { getCollections } from "../functions/getCollections";
import type { MigrateOptionsCli } from "../types/cliOptions";

const migrateCollections = async (
	ymlPath: string,
	cliParams: MigrateOptionsCli,
) => {
	const outputExport = path.resolve(__dirname, "..", "..", "temp-dump");

	if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);
	const options = parseYml<MigrateYmlOptions>(ymlPath, migrateYmlSchema);
	const { migrate } = options.command;
	const limiter = new Bottleneck({ maxConcurrent: cliParams.parallel ?? 2 });

	const clientSource = await conn(migrate.source.uri, "source");
	const dbSource = clientSource.db(migrate.source.db);
	const migrateCollections = await getCollections(
		dbSource,
		cliParams,
		ymlPath,
		migrate.collections,
	);
	/**
	 *
	 * ? MIGRATE COLLECTIONS
	 */
	const successExports = await initMigration(
		migrate.source,
		outputExport,
		limiter,
		migrateCollections,
		migrate.queryString,
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
	const clientDestination = await conn(migrate.destination.uri, "destination");

	/**
	 *
	 * ? SET STATE ON __sync COLLECTION
	 */
	const [successColds, failedColds] = await initRegistrationSync(
		options,
		successRestores,
		clientDestination,
		limiter,
	);

	if (failedColds.length > 0) {
		customLog("info", "Retrying set cold stats on failed collections");

		let [newSuccessColds] = await initRegistrationSync(
			options,
			failedColds,
			clientDestination,
			limiter,
		);
		successColds.push(...newSuccessColds);
	}

	/**
	 *
	 * ? DROP ON DATABASE ALL COLLECTIONS migrateED
	 */
	const [successDrops, failedDrops] = await dropOldCollections(
		clientDestination,
		migrate.destination.db,
		successColds,
		limiter,
	);
	if (failedDrops.length > 0) {
		customLog("info", "Retrying drop failed collections");

		const [newSuccessDrops] = await dropOldCollections(
			clientDestination,
			migrate.destination.db,
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
		clientDestination,
		migrate.destination.db,
		successDrops,
		limiter,
	);

	/**
	 *
	 * ? CLEAN LOCAL REGISTRES (GENERATED FOR migrateCollections)
	 */
	deleteTempFolder(outputExport);

	/**
	 *
	 * ? CLOSE MONGODB CONNECTION
	 */
	await clientSource.close();
	await clientDestination.close();
};

export default migrateCollections;
