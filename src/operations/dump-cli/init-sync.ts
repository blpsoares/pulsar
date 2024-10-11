import type { MongoClient } from 'mongodb';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import type Bottleneck from 'bottleneck';
import { MongoStatusReturns } from '../../utils/mongo-tools-return';

const createSyncStatsOnDestinDb = async (
  client: MongoClient,
  db: string,
  collection: string,
  progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
  try {
    await client
      .db(db)
      .collection('__sync__')
      .updateOne(
        { id: collection },
        { $setOnInsert: { id: collection, status: 'cold' } },
        { upsert: true },
      );
    return { success: collection, failed: false };
  } catch (error) {
    return { failed: collection, success: false };
  } finally {
    progressBar.increment();
  }
};
export const initRegistrationSync = async (
  options: DumpYmlOptions,
  collections: string[],
  client: MongoClient,
  limiter: Bottleneck,
) => {
  const { dump } = options.command;
  customLog('info', 'Init set state on __sync__ collection...');
  const progressBarColdState = createSingleBar(collections.length, 'Set cold state');

  const solvedSetColdState = collections.map((col) =>
    limiter.schedule(() =>
      createSyncStatsOnDestinDb(client, dump.destination.db, col, progressBarColdState),
    ),
  );

  const setColds = await Promise.all(solvedSetColdState);
  progressBarColdState.stop();

  const [successFullColds, failedColds] = MongoStatusReturns(setColds);

  if (failedColds.length > 0) {
    customLog('warn', 'Some states can not be set, check these collections on src/logs/debug.log');
    logger.error(`Collections with no Set states -> ["${failedColds.join('","')}"]`);
  }
  customLog('success', 'Set cold state on documents in __sync__\n');
  return [successFullColds, failedColds];
};
