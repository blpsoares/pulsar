import type { MongoClient } from 'mongodb';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog } from '../../utils/custom-log';

const createSyncStatsOnDestinDb = async (
  client: MongoClient,
  db: string,
  col: string,
  progressBar: SingleBar,
): Promise<void> => {
  await client
    .db(db)
    .collection('__sync__')
    .updateOne({ id: col }, { $setOnInsert: { id: col, status: 'cold' } }, { upsert: true });
  progressBar.increment();
};
export const initRegistrationSync = async (
  options: DumpYmlOptions,
  collections: string[],
  client: MongoClient,
) => {
  const { dump } = options.command;
  customLog('info', 'Init set state on __sync__ collection...');
  const progressBarColdState = createSingleBar(collections.length, 'Set cold state');
  const solvedSetColdState = collections.map((col) =>
    createSyncStatsOnDestinDb(client, dump.destination.db, col, progressBarColdState),
  );

  await Promise.all(solvedSetColdState);
  progressBarColdState.stop();
  customLog('success', 'Setted cold state on documents in __sync__ collection\n');
};
