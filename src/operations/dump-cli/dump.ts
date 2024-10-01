import type Bottleneck from 'bottleneck';
import { $ } from 'bun';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import { errorHandler } from '../../errors/error-handler';

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
  col: string,
  outputExport: string,
  progressBar: SingleBar,
) => {
  const proc = Bun.spawn([
    'mongodump',
    `--uri=${uri}`,
    `--db=${db}`,
    `--collection=${col}`,
    `--out=${outputExport}`,
    `--quiet`,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    customLog('error', `Error to export collection: ${col}`);
    return;
  }

  progressBar.increment();
  logger.info(`Exported: ${col}`);
  return col;
};

export const initDump = async (
  options: DumpYmlOptions,
  outputExport: string,
  limiter: Bottleneck,
) => {
  const { dump } = options.command;
  customLog('info', 'Init dump collections...');
  const progressBarExport = createSingleBar(dump.collections.length, 'Dump progress ');

  const exportCollectionsPromises = dump.collections.map((col) =>
    limiter.schedule(() =>
      createChildProcessToDump(
        dump.source.uri,
        dump.source.db,
        col,
        outputExport,
        progressBarExport,
      ),
    ),
  );

  const solvedExports = await Promise.all(exportCollectionsPromises);
  const filteredExports: string[] = solvedExports.filter(
    (item): item is string => item !== undefined,
  );
  progressBarExport.stop();
  console.log(`FILTERED EXPORTS ${filteredExports}`);
  if (filteredExports.length === 0) {
    throw errorHandler(
      new Error(
        'No collections imported, please verify your database (source or destin) and your array collection',
      ),
      'RESTORE:FILTERED:EXPORTS',
    );
  }

  customLog('success', `Exported collections: ${solvedExports.join(', ')}\n`);
  return filteredExports;
};
