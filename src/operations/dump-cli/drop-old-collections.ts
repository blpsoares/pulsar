import Bottleneck from 'bottleneck';
import type { MongoClient } from 'mongodb';
import { customLog, logger } from '../../utils/custom-log';

export const dropOldCollections = async (
  client: MongoClient,
  dbName: string,
  collections: string[],
) => {
  const db = client.db(dbName);
  const limiter = new Bottleneck({ maxConcurrent: 10 });
  customLog('info', 'Drop old collections...');
  const promises = collections.map((col) => limiter.schedule(() => db.dropCollection(col)));

  try {
    await Promise.all(promises);
  } catch (error) {
    logger.error(`Error to drop collection: ${error}`);
  } finally {
    customLog('success', 'Dropped old collections\n');
  }
};
