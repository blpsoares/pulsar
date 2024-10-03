import type Bottleneck from 'bottleneck';
import { $ } from 'bun';
import type { SingleBar } from 'cli-progress';
import { createSingleBar } from '../../utils/create-progress-bar';
import { customLog, logger } from '../../utils/custom-log';
import { errorHandler } from '../../errors/error-handler';
import { mongoToolsReturns } from '../../utils/mongo-tools-return';

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
  collection: string,
  progressBar: SingleBar,
): Promise<MongoToolsReturn> => {
  const proc = Bun.spawn([
    'mongorestore',
    `--uri="${uri}/${dbDestin}"`,
    `--collection="_dump_${collection}"`,
    `temp-dump/${dbSrc}/${collection}.bson`,
    `--quiet`,
  ]);

  await proc.exited;
  logger.debug(
    `Mongorestore command generated:\n mongorestore --uri="<CREDENTIALS>/<DATABASE>" --collection="_dump_${collection}" temp-dump/${dbSrc}/${collection}.bson --quiet\n`,
  );

  if (proc.exitCode !== 0) {
    logger.error(`Error to restore collection: ${collection} Exit process code: ${proc.exitCode}`);
    return { sucess: false, failed: collection };
  }

  progressBar.increment();
  logger.info(`Restored: ${collection}`);
  return { sucess: collection, failed: false };
};

export const initRestore = async (
  options: DumpYmlOptions,
  collections: string[],
  limiter: Bottleneck,
) => {
  const { dump } = options.command;
  customLog('info', 'Init restore collections...');
  const progressBarImport = createSingleBar(collections.length, 'Restore progress');

  const importCollectionsPromises = collections.map((collection) =>
    limiter.schedule(() =>
      executeRestoreCommand(
        dump.destination.uri,
        dump.source.db,
        dump.destination.db,
        collection,
        progressBarImport,
      ),
    ),
  );

  const solvedRestores = await Promise.all(importCollectionsPromises);
  progressBarImport.stop();

  const [successfulExports, failedRestores] = mongoToolsReturns(solvedRestores);

  if (successfulExports.length === 0) {
    throw errorHandler(
      new Error(
        'No collections restored by mongorestore, please verify your database (source or destin) and your array collection',
      ),
      'RESTORE:FILTERED:IMPORTS',
    );
  }
  if (failedRestores.length > 0) {
    customLog(
      'warn',
      `Some collections were not restored, check the logs at src/logs/error.log to view these collections`,
    );

    logger.error(`No restored collections\n${failedRestores.join('\n\t\t\t✕ ')}`);
  }

  customLog('success', `Imported collections: ${successfulExports.join(', ')}\n`);
  return successfulExports;
};
