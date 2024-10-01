import Bottleneck from 'bottleneck';
import { logger, customLog } from '../../utils/custom-log';
import { MongoClient } from 'mongodb';

export const renameNewCollections = async (
  client: MongoClient,
  dbName: string,
  collections: string[],
) => {
  const db = client.db(dbName);
  const limiter = new Bottleneck({ maxConcurrent: 2 });
  customLog('info', 'Rename all new collections...');
  const promises = collections.map((col) =>
    limiter.schedule(() => db.renameCollection(`_dump_${col}`, col)),
  );
  try {
    await Promise.all(promises);
  } catch (error) {
    logger.error(`Error to rename collection: ${error}`);
  } finally {
    customLog('success', 'Renamed all new collections \n');
  }
};
