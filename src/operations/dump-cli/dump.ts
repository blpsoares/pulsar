import type Bottleneck from 'bottleneck';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import fs from 'fs/promises';
import { MongoStatusReturns } from '../../utils/mongo-tools-return';
import { ObjectId } from 'mongodb';

const data = new Date(`2024-09-01`);
const objectId = new ObjectId(Math.floor(data.getTime() / 1000).toString(16) + '0000000000000000');
const queryString = JSON.stringify({ _id: { $gte: { $oid: objectId.toString() } } });

const createChildProcessToDump = async (
  uri: string,
  db: string,
  collection: string,
  outputExport: string,
  progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
  if (uri.endsWith('/')) uri = uri.slice(0, -1);
  const proc = Bun.spawn([
    'mongodump',
    `--uri="${uri}/${db}"`,
    `--collection="${collection}"`,
    `--query=${queryString}`,
    `--out="${outputExport}"`,
    `--quiet`,
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    logger.error(`Error to export collection: ${collection} Exit process code: ${proc.exitCode}`);
    return { success: false, failed: collection };
  }

  const exportedFileExists = await fs.exists(`${outputExport}/${db}/${collection}.bson`);
  if (!exportedFileExists) return { success: false, failed: collection };

  progressBar.increment();
  logger.info(`Exported: ${collection}\n`);
  return { success: collection, failed: false };
};

export const initDump = async (
  source: DumpYmlOptions['command']['dump']['source'],
  outputExport: string,
  limiter: Bottleneck,
  collections: string[],
) => {
  customLog('info', 'Init dump collections...');
  const progressBarExport = createSingleBar(collections.length, 'Dump progress ');

  const exportCollectionsPromises = collections.map((collection) =>
    limiter.schedule(() =>
      createChildProcessToDump(source.uri, source.db, collection, outputExport, progressBarExport),
    ),
  );

  const solvedExports = await Promise.all(exportCollectionsPromises);
  progressBarExport.stop();

  const [successfulExports, failedExports] = MongoStatusReturns(solvedExports);

  if (failedExports.length > 0) {
    customLog(
      'warn',
      `Some collections were not exported, check the logs at src/logs/error.log to view these collections`,
    );

    logger.error(`No exported collections\n["${failedExports.join('","')}"]`);
  }
  customLog('success', `Exported collections\n`);
  return [successfulExports, failedExports];
};
