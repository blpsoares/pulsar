import type Bottleneck from 'bottleneck';
import { $ } from 'bun';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import { errorHandler } from '../../errors/error-handler';

// * This function create a child process with mongorestore command
// const createChildProcessToRestore = async (
//   uri: string,
//   dbSrc: string,
//   dbDestin: string,
//   col: string,
//   progressBar: SingleBar,
// ) => {
//   const { exitCode } =
//     await $`mongorestore --uri=${uri} --db=${dbDestin} --collection=_dump_${col} temp-dump/${dbSrc}/${col}.bson`
//       .nothrow()
//       .quiet();

//   if (exitCode !== 0) customLog('error', `Error to restore collection: ${col}`);

//   progressBar.increment();
//   logger.info(`Exported: ${col}`);
//   return col;
// };

//* This funcion execute a shell command, but does not create a child process
const executeRestoreCommand = async (
  uri: string,
  dbSrc: string,
  dbDestin: string,
  col: string,
  progressBar: SingleBar,
) => {
  const proc = Bun.spawn([
    'mongorestore',
    `--uri=${uri}`,
    `--db=${dbDestin}`,
    `--collection=_dump_${col}`,
    `temp-dump/${dbSrc}/${col}.bson`,
    `--quiet`,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    customLog('error', `Error to restore collection: ${col}`);
    return;
  }

  progressBar.increment();
  logger.info(`Exported: ${col}`);
  return col;
};

export const initRestore = async (
  options: DumpYmlOptions,
  collections: string[],
  limiter: Bottleneck,
) => {
  const { dump } = options.command;
  customLog('info', 'Init import collections...');
  const progressBarImport = createSingleBar(collections.length, 'Import progress');

  const importCollectionsPromises = collections.map((col) =>
    limiter.schedule(() =>
      executeRestoreCommand(
        dump.destination.uri,
        dump.source.db,
        dump.destination.db,
        col,
        progressBarImport,
      ),
    ),
  );

  const solvedImports = await Promise.all(importCollectionsPromises);
  const filteredImports: string[] = solvedImports.filter(
    (item): item is string => item !== undefined,
  );
  progressBarImport.stop();

  if (filteredImports.length === 0) {
    throw errorHandler(
      new Error(
        'No collections imported, please verify your database (source or destin) and your array collection',
      ),
      'RESTORE:FILTERED:IMPORTS',
    );
  }

  customLog('success', `Imported collections: ${solvedImports.join(', ')}\n`);
  return filteredImports;
};
