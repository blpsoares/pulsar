import type Bottleneck from "bottleneck";
import type { SingleBar } from "cli-progress";
import { createSingleBar } from "../../utils/createProgressBar";
import { customLog, logger } from "../../utils/customLog";
import fs from "fs/promises";
import { existsSync } from "fs";
import { MongoStatusReturns } from "../../utils/mongo";
import { $ } from "bun";
import type { MigrateYmlOptions } from "../../types/parseYml";
import { errorHandler } from "../../errors/errorHandler";
import { getPreviouslyExportedCollections } from "./restoreDump";

const createChildProcessToDump = async (
	uri: string,
	db: string,
	collection: string,
	queryString: string = "",
	outputExport: string,
	progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
	if (uri.endsWith("/")) uri = uri.slice(0, -1);
	const { stderr, stdout, exitCode } =
		await $`mongodump --uri="${uri}/${db}" --collection="${collection}" --query=${queryString} --out="${outputExport}"`
			.nothrow()
			.quiet();

	if (exitCode !== 0) {
		logger.error(
			`Error to export collection: ${collection}\nExit process code: ${exitCode}\nError: ${stderr}\nOutput: ${stdout}`,
		);
		return { success: false, failed: collection };
	}

	const exportedFileExists = await fs.exists(
		`${outputExport}/${db}/${collection}.bson`,
	);
	if (!exportedFileExists) return { success: false, failed: collection };

	progressBar.increment();
	logger.info(`Exported: ${collection}\n`);
	return { success: collection, failed: false };
};

export const dumpCollections = async (
	source: MigrateYmlOptions["command"]["dump"]["source"],
	outputExport: string,
	limiter: Bottleneck,
	collections: string[],
	query?: string,
) => {
	customLog("info", "Init dump collections...", true);
	const progressBarExport = createSingleBar(
		collections.length,
		"Dump progress ",
	);

	const exportCollectionsPromises = collections.map((collection) =>
		limiter.schedule(() =>
			createChildProcessToDump(
				source.uri,
				source.db,
				collection,
				query,
				outputExport,
				progressBarExport,
			),
		),
	);

	const solvedExports = await Promise.all(exportCollectionsPromises);
	progressBarExport.stop();

	const [successfulExports, failedExports] = MongoStatusReturns(solvedExports);

	if (failedExports.length > 0) {
		customLog(
			"warn",
			`Some collections were not exported, check the logs at logs/error.log to view these collections`,
		);

		logger.error(`No exported collections\n["${failedExports.join('","')}"]`);
	}

	if (failedExports.length === 0)
		customLog("success", `Collections exporteds\n`);
	return [successfulExports, failedExports];
};

export const initMigration = async (
	sourceUri: MigrateYmlOptions["command"]["dump"]["source"],
	outputPath: string,
	limiter: Bottleneck,
	collections: string[],
	queryString: string = "",
	maxRetries: number = 3,
) => {
	let alreadyExported: string[] = [];
	const dumpPath = `temp-dump/${sourceUri.db}`;

	const tempDumpExists = existsSync(dumpPath);
	if (tempDumpExists) {
		alreadyExported = getPreviouslyExportedCollections(dumpPath);
	}

	let remainingCollections = collections.filter(
		(collection) => !alreadyExported.includes(collection),
	);

	const allSuccess: string[] = [...alreadyExported];
	let attempts = 0;

	while (remainingCollections.length > 0 && attempts < maxRetries) {
		const [success, failed] = await dumpCollections(
			sourceUri,
			outputPath,
			limiter,
			remainingCollections,
			queryString,
		);
		allSuccess.push(...success);
		remainingCollections = failed;

		if (failed.length > 0) {
			customLog(
				"warn",
				`${attempts + 1}° Retrying export for collections: ${failed.join(", ")}`,
			);
		}

		attempts++;
	}

	if (remainingCollections.length > 0) {
		throw errorHandler(
			`Failed to export collections after ${maxRetries} attempts: ${remainingCollections}`,
		);
	}

	return [...new Set(allSuccess)];
};
