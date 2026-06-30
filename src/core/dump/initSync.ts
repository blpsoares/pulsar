import type Bottleneck from "bottleneck";
import type { SingleBar } from "cli-progress";
import type { MongoClient } from "mongodb";
import type { MigrateYmlOptions } from "../../types/parseYml";
import { createSingleBar } from "../../utils/createProgressBar";
import { customLog, logger } from "../../utils/customLog";
import { MongoStatusReturns } from "../../utils/mongo";

const createSyncStatsOnDestinDb = async (
	client: MongoClient,
	db: string,
	collection: string,
	progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
	try {
		await client
			.db(db)
			.collection("__sync")
			.updateOne(
				{ id: collection },
				{
					$setOnInsert: {
						id: collection,
						status: "cold",
					},
					$set: { ts: Date.now() },
				},
				{ upsert: true },
			);
		return { success: collection, failed: false };
	} catch (_error) {
		return { failed: collection, success: false };
	} finally {
		progressBar.increment();
	}
};
export const initRegistrationSync = async (
	options: MigrateYmlOptions,
	collections: string[],
	client: MongoClient,
	limiter: Bottleneck,
) => {
	const { migrate } = options.command;
	customLog("info", "Init set state on __sync collection...");
	const progressBarColdState = createSingleBar(
		collections.length,
		"Set cold state",
	);

	const solvedSetColdState = collections.map((col) =>
		limiter.schedule(() =>
			createSyncStatsOnDestinDb(
				client,
				migrate.destination.db,
				col,
				progressBarColdState,
			),
		),
	);

	const setColds = await Promise.all(solvedSetColdState);
	progressBarColdState.stop();

	const [successFullColds, failedColds] = MongoStatusReturns(setColds);

	if (failedColds.length > 0) {
		customLog(
			"warn",
			"Some states can not be set, check these collections on src/logs/debug.log",
		);
		logger.error(
			`Collections with no Set states -> ["${failedColds.join('","')}"]`,
		);
	}
	customLog("success", "Set cold state on documents in __sync\n");
	return [successFullColds, failedColds];
};
