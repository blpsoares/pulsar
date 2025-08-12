import type Bottleneck from "bottleneck";
import type { SingleBar } from "cli-progress";
import { createSingleBar } from "../../utils/createProgressBar";
import { customLog, logger } from "../../utils/customLog";
import { MongoStatusReturns } from "../../utils/mongoToolsReturn";
import { $ } from "bun";
import type { DumpYmlOptions } from "../../types/parseYml";
import { readdirSync, unlinkSync } from "fs";
import path from "path";
import chalk from "chalk";

const executeRestoreCommand = async (
	uri: string,
	dbSrc: string,
	dbDestin: string,
	collection: string,
	progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
	if (uri.endsWith("/")) uri = uri.slice(0, -1);
	const { stderr, stdout, exitCode } =
		await $`mongorestore --uri="${uri}/${dbDestin}" --collection="_dump_${collection}" temp-dump/${dbSrc}/${collection}.bson`
			.nothrow()
			.quiet();

	if (exitCode !== 0) {
		logger.error(
			`Error to restore collection: ${collection}\nExit process code: ${exitCode}\nError: ${stderr}\nOutput: ${stdout}`,
		);
		return { success: false, failed: collection };
	}

	progressBar.increment();
	logger.info(`Restored: ${collection}\n`);
	unlinkSync(`temp-dump/${dbSrc}/${collection}.bson`);
	unlinkSync(`temp-dump/${dbSrc}/${collection}.metadata.json`);
	return { success: collection, failed: false };
};

export const restoreCollections = async (
	options: DumpYmlOptions,
	collections: string[],
	limiter: Bottleneck,
) => {
	const { dump } = options.command;
	customLog("info", "Init restore collections...");
	const progressBarImport = createSingleBar(
		collections.length,
		"Restore progress",
	);

	const importCollectionsPromises = collections.map((collection) =>
		limiter.schedule(() =>
			executeRestoreCommand(
				dump.destination.uri,
				dump.source.db,
				dump.destination.db,
				collection,
				progressBarImport,
			),
		),
	);

	const solvedRestores = await Promise.all(importCollectionsPromises);
	progressBarImport.stop();

	const [successFullRestores, failedRestores] =
		MongoStatusReturns(solvedRestores);

	if (failedRestores.length > 0) {
		customLog(
			"warn",
			`Some collections were not restored, check the logs at src/logs/error.log to view these collections`,
		);

		logger.error(`No restored collections\n["${failedRestores.join('","')}"]`);
	}
	if (failedRestores.length === 0)
		customLog("success", `Collections restored\n`);

	return [successFullRestores, failedRestores];
};

export const initRestore = async (
	options: DumpYmlOptions,
	collections: string[],
	limiter: Bottleneck,
	maxRetries: number = 3,
): Promise<[string[], string[]]> => {
	let remainingCollections = collections;
	const allSuccess: string[] = [];
	let attempts = 0;

	while (remainingCollections.length > 0 && attempts < maxRetries) {
		const [success, failed] = await restoreCollections(
			options,
			remainingCollections,
			limiter,
		);
		allSuccess.push(...success);
		remainingCollections = failed;

		if (failed.length > 0) {
			customLog(
				"warn",
				`${attempts + 1}° Retrying restore for collections: ${failed.join(", ")}`,
			);
		}

		attempts++;
	}

	if (remainingCollections.length > 0) {
		customLog(
			"error",
			`Failed to restore collections after ${maxRetries} attempts: ${remainingCollections}`,
		);
	}

	return [allSuccess, remainingCollections];
};

export function getPreviouslyExportedCollections(dumpPath: string) {
	const files = readdirSync(dumpPath);

	const bsonNames = new Set(
		files
			.filter((file) => path.extname(file) === ".bson")
			.map((file) => path.basename(file, ".bson")),
	);

	const jsonNames = new Set(
		files
			.filter((file) => file.endsWith(".metadata.json"))
			.map((file) => file.replace(".metadata.json", "")),
	);

	const alreadyExported = [...bsonNames].filter((name) => jsonNames.has(name));
	customLog(
		"info",
		`Skipping ${alreadyExported.length} previously exported collections: ${chalk.gray(alreadyExported.join(", "))}`,
		true,
	);

	return alreadyExported;
}
