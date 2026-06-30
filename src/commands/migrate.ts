import Bottleneck from "bottleneck";
import fs from "fs";
import path from "path";
import { dropOldCollections } from "../core/dump/dropOldCollections";
import { initMigration } from "../core/dump/dump";
import { initRegistrationSync } from "../core/dump/initSync";
import { renameNewCollections } from "../core/dump/renameCollections";
import { initRestore } from "../core/dump/restoreDump";
import { conn } from "../db/conn";
import { assertMongoTools } from "../functions/assertMongoTools";
import { getCollections } from "../functions/getCollections";
import type { MigrateOptionsCli } from "../types/cliOptions";
import { type MigrateYmlOptions, migrateYmlSchema } from "../types/parseYml";
import { customLog } from "../utils/customLog";
import { deleteTempFolder } from "../utils/deleteTempFolder";
import { t } from "../utils/i18n";
import { formatLoadReport } from "../utils/loadReport";
import parseYml from "../utils/parseYml";

const migrateCollections = async (
	ymlPath: string,
	cliParams: MigrateOptionsCli,
) => {
	// Preflight: garante mongodump/mongorestore no PATH antes de tocar no Atlas.
	assertMongoTools();

	const outputExport = path.resolve(__dirname, "..", "..", "temp-dump");

	if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);
	const options = parseYml<MigrateYmlOptions>(ymlPath, migrateYmlSchema);
	const { migrate } = options.command;
	const limiter = new Bottleneck({ maxConcurrent: cliParams.parallel ?? 2 });

	const clientSource = await conn(migrate.source.uri, "source");
	const dbSource = clientSource.db(migrate.source.db);
	const collectionEntries = await getCollections(
		dbSource,
		cliParams,
		ymlPath,
		migrate.collections,
	);
	const migrateCollections = collectionEntries.map((e) => e.name);

	// Início da carga (1ª collection) — p/ o relatório de tempo total ao final.
	const startedAt = Date.now();
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
		customLog("error", t("migrate.restore_failed", { list: failedRestores }));
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
		customLog("info", t("migrate.retry_cold"));

		const [newSuccessColds] = await initRegistrationSync(
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
		customLog("info", t("migrate.retry_drop"));

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

	// Banco "up" — todas as collections migradas e renomeadas. Relatório de tempo.
	customLog(
		"info",
		formatLoadReport(migrateCollections.length, startedAt, Date.now()),
		true,
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
