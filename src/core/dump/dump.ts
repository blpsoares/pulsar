import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type Bottleneck from "bottleneck";
import { $ } from "bun";
import type { SingleBar } from "cli-progress";
import { errorHandler } from "../../errors/errorHandler";
import type { MigrateYmlOptions } from "../../types/parseYml";
import { createSingleBar } from "../../utils/createProgressBar";
import { customLog, logger } from "../../utils/customLog";
import { MongoStatusReturns } from "../../utils/mongo";
import { getPreviouslyExportedCollections } from "./restoreDump";

/**
 * Detecta o erro do mongodump quando a collection não existe na origem
 * ("namespace with DB x and collection y does not exist"). É um erro
 * NÃO-RETENTÁVEL: por mais que se tente, a collection nunca vai aparecer.
 */
export const isNamespaceMissing = (stderr: string): boolean =>
	/namespace .* does not exist/i.test(stderr);

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
		const stderrText = stderr.toString();
		// Collection inexistente → marca como "missing" (pula, não retenta).
		if (isNamespaceMissing(stderrText)) {
			logger.warn(
				`Skipping collection that does not exist on source: ${collection}`,
			);
			return { success: false, failed: false, missing: collection };
		}
		logger.error(
			`Error to export collection: ${collection}\nExit process code: ${exitCode}\nError: ${stderrText}\nOutput: ${stdout}`,
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

	const [successfulExports, failedExports, missingExports] =
		MongoStatusReturns(solvedExports);

	if (failedExports.length > 0) {
		customLog(
			"warn",
			`Some collections were not exported, check the logs at logs/error.log to view these collections`,
		);

		logger.error(`No exported collections\n["${failedExports.join('","')}"]`);
	}

	if (failedExports.length === 0 && missingExports.length === 0)
		customLog("success", `Collections exporteds\n`);
	return [successfulExports, failedExports, missingExports];
};

/** Resultado de um round de dump: [sucesso, falha transitória, inexistente]. */
type DumpRound = (collections: string[]) => Promise<string[][]>;

export const initMigration = async (
	sourceUri: MigrateYmlOptions["command"]["dump"]["source"],
	outputPath: string,
	limiter: Bottleneck,
	collections: string[],
	queryString: string = "",
	maxRetries: number = 3,
	// Injetável p/ teste; em produção usa o dumpCollections real (mongodump).
	dumpFn?: DumpRound,
) => {
	const dump: DumpRound =
		dumpFn ??
		((cols) =>
			dumpCollections(sourceUri, outputPath, limiter, cols, queryString));

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
	const allMissing: string[] = [];
	let attempts = 0;

	while (remainingCollections.length > 0 && attempts < maxRetries) {
		const [success, failed, missing = []] = await dump(remainingCollections);
		allSuccess.push(...success);
		allMissing.push(...missing);
		// "missing" sai do ciclo de retry: a collection não existe, retentar é inútil.
		remainingCollections = failed;

		if (failed.length > 0) {
			customLog(
				"warn",
				`${attempts + 1}° Retrying export for collections: ${failed.join(", ")}`,
			);
		}

		attempts++;
	}

	if (allMissing.length > 0) {
		customLog(
			"warn",
			`Skipped ${allMissing.length} collection(s) that do not exist on source: ${allMissing.join(", ")}`,
		);
	}

	if (remainingCollections.length > 0) {
		// Falha transitória que esgotou os retries: loga e SEGUE com o que deu certo.
		customLog(
			"warn",
			`Continuing without ${remainingCollections.length} collection(s) that failed export after ${maxRetries} attempts: ${remainingCollections.join(", ")}`,
		);
	}

	const exported = [...new Set(allSuccess)];

	// Só aborta de verdade quando NADA foi exportado (não há o que restaurar).
	if (exported.length === 0) {
		throw errorHandler(
			`No collections were exported. Failed: [${remainingCollections.join(", ")}]; missing on source: [${allMissing.join(", ")}]`,
		);
	}

	return exported;
};
