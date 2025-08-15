import Bottleneck from "bottleneck";
import type { Db, MongoClient } from "mongodb";
import { customLog, logger } from "../../utils/customLog";
import { MongoStatusReturns } from "../../utils/mongo";
import { createSingleBar } from "../../utils/createProgressBar";
import type { SingleBar } from "cli-progress";

const validateDropCollections = async (
	db: Db,
	collection: string,
	progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
	const notDropped: MongoStatusReturn = { failed: collection, success: false };
	const collExists = await db.listCollections({ name: collection }).toArray();
	if (collExists.length > 0) {
		try {
			const dropped = await db.dropCollection(collection, {});
			if (!dropped) return notDropped;
		} catch (_) {
			return notDropped;
		}
	}
	progressBar.increment();
	return { failed: false, success: collection };
};

export const dropOldCollections = async (
	client: MongoClient,
	dbName: string,
	collections: string[],
	limiter: Bottleneck,
) => {
	const db = client.db(dbName);
	customLog("info", "Drop old collections...");
	const progressBarDrop = createSingleBar(collections.length, "Drop progress");
	const droppedCollectionsPromise = collections.map((collection) =>
		limiter.schedule(() =>
			validateDropCollections(db, collection, progressBarDrop),
		),
	);

	const droppedCollections = await Promise.all(droppedCollectionsPromise);
	progressBarDrop.stop();

	const [successDrops, failedDrops] = MongoStatusReturns(droppedCollections);

	if (failedDrops.length > 0) {
		customLog(
			"warn",
			`Some collections were not dropped, check the logs at src/logs/error.log to view these collections`,
		);

		logger.error(`No dropped collections\n["${failedDrops.join('","')}"]`);
	}

	customLog("success", `Dropped old collections\n`);
	return [successDrops, failedDrops];
};
