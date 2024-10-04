import type Bottleneck from 'bottleneck';
import { $ } from 'bun';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import { errorHandler } from '../../errors/error-handler';
import fs from 'fs/promises';
import { log } from 'winston';
import { MongoStatusReturns } from '../../utils/mongo-tools-return';

// * This function create a child process with mongodump command
// const executeDumpCommand = async (
//   uri: string,
//   db: string,
//   col: string,
//   outputExport: string,
//   progressBar: SingleBar,
// ) => {
//   const proc = Bun.spawn([
//     "mongodump",
//     `--uri=${uri}`,
//     `--db=${db}`,
//     `--collection=${col}`,
//     `--out=${outputExport}`
//   ]);

//   const { exitCode } = await proc.exited;

//   if (exitCode !== 0) {
//     customLog('error', `Error to export collection: ${col}`);
//   }

//   progressBar.increment();
//   logger.info(`Exported: ${col}`);
//   return col;
// };

//* This funcion execute a shell command, but does not create a child process
const createChildProcessToDump = async (
  uri: string,
  db: string,
  collection: string,
  outputExport: string,
  progressBar: SingleBar,
): Promise<MongoStatusReturn> => {
  const proc = Bun.spawn([
    'mongodump',
    `--uri="${uri}/${db}"`,
    `--collection="${collection}"`,
    `--out="${outputExport}"`,
    `--quiet`,
  ]);

  await proc.exited;
  logger.debug(
    `Tools command generated:\n mongodump --uri="<CREDENTIALS>/<DATABASE>" --collection="${collection}" --out="${outputExport}" --quiet\n`,
  );

  if (proc.exitCode !== 0) {
    logger.error(`Error to export collection: ${collection} Exit process code: ${proc.exitCode}`);
    return { success: false, failed: collection };
  }

  const exportedFileExists = await fs.exists(`${outputExport}/${db}/${collection}.bson`);
  if (!exportedFileExists) return { success: false, failed: collection };

  progressBar.increment();
  logger.info(`Exported: ${collection}`);
  return { success: collection, failed: false };
};

export const initDump = async (
  options: DumpYmlOptions,
  outputExport: string,
  limiter: Bottleneck,
) => {
  const { dump } = options.command;
  customLog('info', 'Init dump collections...');
  const progressBarExport = createSingleBar(dump.collections.length, 'Dump progress ');

  const exportCollectionsPromises = dump.collections.map((collection) =>
    limiter.schedule(() =>
      createChildProcessToDump(
        dump.source.uri,
        dump.source.db,
        collection,
        outputExport,
        progressBarExport,
      ),
    ),
  );

  const solvedExports = await Promise.all(exportCollectionsPromises);
  progressBarExport.stop();

  const [successfulExports, failedExports] = MongoStatusReturns(solvedExports);

  if (successfulExports.length === 0) {
    throw errorHandler(
      new Error(
        'No collections exported, please verify your database (source or destin) and your array collection',
      ),
      'RESTORE:FILTERED:EXPORTS',
    );
  }
  if (failedExports.length > 0) {
    customLog(
      'warn',
      `Some collections were not exported, check the logs at src/logs/error.log to view these collections`,
    );

    logger.error(`No exported collections\n${failedExports.join('\n\t\t\t✕ ')}\nPossible causes:
- Collections do not exist in the source database\n`);
  }
  customLog('success', `Exported collections\n`);
  return successfulExports;
};
