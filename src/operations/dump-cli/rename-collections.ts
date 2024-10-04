import Bottleneck from 'bottleneck';
import { logger, customLog } from '../../utils/custom-log';
import { Db, MongoClient } from 'mongodb';
import { MongoStatusReturns } from '../../utils/mongo-tools-return';
import { errorHandler } from '../../errors/error-handler';
import { createSingleBar } from '../../utils/create-progress-bar';
import type { SingleBar } from 'cli-progress';

const dbRenameCollection = async (
  db: Db,
  collection: string,
  progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
  const dumpCollectionName = `_dump_${collection}`;
  try {
    const existsColl = await db.listCollections({ name: dumpCollectionName }).hasNext();
    if (!existsColl) {
      logger.error(`The collection: ${dumpCollectionName} does not exist in your database.`);
      return { failed: collection, success: false };
    }

    await db.renameCollection(dumpCollectionName, collection);
    logger.info(`Successfully renamed collection FROM: ${dumpCollectionName} TO: ${collection}`);
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
  customLog('info', 'Rename all new collections...');
  const progressBarRename = createSingleBar(collections.length, 'Rename progress');
  const renameCollectionsPromises = collections.map((collections) =>
    limiter.schedule(() => dbRenameCollection(db, collections, progressBarRename)),
  );

  const solvedRenames = await Promise.all(renameCollectionsPromises);
  progressBarRename.stop();

  const [successfullRenames, failedRenames] = MongoStatusReturns(solvedRenames);

  if (successfullRenames.length === 0) {
    throw errorHandler(
      new Error('No collections renamed, please verify collections names'),
      'RENAME:FILTERED',
    );
  }

  if (failedRenames.length > 0) {
    customLog(
      'warn',
      'Some collections can not renamed, check these collections on src/logs/debug.log',
    );
    logger.error(`No renamed collections\n${failedRenames.join('\n\t\t\t✕ ')}`);
  }

  customLog('success', `Renamed collections \n`);
};
