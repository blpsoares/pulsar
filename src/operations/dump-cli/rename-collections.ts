import Bottleneck from 'bottleneck';
import { logger, customLog } from '../../utils/custom-log';
import { Db, MongoClient } from 'mongodb';

const dbRenameCollection = async (db: Db, collection: string) => {
  logger.info(`Init step of rename collections - from: _dump_${collection} | to: ${collection}\n`);
  await db.renameCollection(`_dump_${collection}`, collection);
};

export const renameNewCollections = async (
  client: MongoClient,
  dbName: string,
  collections: string[],
) => {
  const db = client.db(dbName);
  const limiter = new Bottleneck({ maxConcurrent: 2 });
  customLog('info', 'Rename all new collections...');
  const promises = collections.map((collection) =>
    limiter.schedule(() => dbRenameCollection(db, collection)),
  );

  try {
    await Promise.all(promises);
  } catch (error) {
    logger.error(`Error to rename collection: ${error}`);
  } finally {
    customLog('success', 'Renamed all new collections \n');
  }
};
