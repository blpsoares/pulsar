import Bottleneck from "bottleneck";
import { logger, customLog } from "../../utils/customLog";
import { Db, MongoClient } from "mongodb";
import { MongoStatusReturns } from "../../utils/mongoToolsReturn";
import { createSingleBar } from "../../utils/createProgressBar";
import type { SingleBar } from "cli-progress";

const dbRenameCollection = async (
	db: Db,
	collection: string,
	progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
	const dumpCollectionName = `_dump_${collection}`;
	try {
		const existsColl = await db
			.listCollections({ name: dumpCollectionName })
			.hasNext();
		if (!existsColl) {
			logger.error(
				`The collection: ${dumpCollectionName} does not exist in your database.`,
			);
			return { failed: collection, success: false };
		}

		await db.renameCollection(dumpCollectionName, collection);
		logger.info(
			`Successfully renamed collection FROM: ${dumpCollectionName} TO: ${collection}`,
		);
		return { success: collection, failed: false };
	} catch (error) {
		logger.error(
			`Failed to rename collection FROM: ${dumpCollectionName} TO: ${collection}: ${error}`,
		);
		return { failed: collection, success: false };
	} finally {
		progressBar.increment();
	}
};

export const renameNewCollections = async (
	client: MongoClient,
	dbName: string,
	collections: string[],
	limiter: Bottleneck,
) => {
	const db = client.db(dbName);
	customLog("info", "Rename all new collections...");
	const progressBarRename = createSingleBar(
		collections.length,
		"Rename progress",
	);
	const renameCollectionsPromises = collections.map((collections) =>
		limiter.schedule(() =>
			dbRenameCollection(db, collections, progressBarRename),
		),
	);

	const solvedRenames = await Promise.all(renameCollectionsPromises);
	progressBarRename.stop();

	const [successfullRenames, failedRenames] = MongoStatusReturns(solvedRenames);

	if (failedRenames.length > 0) {
		customLog(
			"warn",
			"Some collections can not renamed, check these collections on src/logs/debug.log",
		);
		logger.error(`No renamed collections\n["${failedRenames.join('","')}"]`);
	}

	customLog("success", `Renamed collections \n`);
};
