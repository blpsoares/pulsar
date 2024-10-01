import parseYml from '../utils/parse-yml';
import fs from 'fs';
import path from 'path';
import Bottleneck from 'bottleneck';
import { createSingleBar } from '../utils/create-progress-bar';
import type { SingleBar } from 'cli-progress';
import logger, { customLog } from '../utils/custom-log';
import { conn } from '../db/conn';
import type { MongoClient } from 'mongodb';
import { $ } from 'bun';

// TODO: move three database ops to new folder
/**
 // TODO -> add error handler on:
 *  todo -> createChildProcessToExport,
 *  todo -> createChildProcessToImport,
 *  todo -> createSyncStatsOnDestinDb,
 *  todo -> dropOldCollections
 *  todo -> and renameNewCollections
 */

const createChildProcessToDump = async (
  uri: string,
  db: string,
  col: string,
  outputExport: string,
  progressBar: SingleBar,
) => {
  const { exitCode } =
    await $`mongodump --uri=${uri} --db=${db} --collection=${col} --out=${outputExport}`
      .nothrow()
      .quiet();

  if (exitCode !== 0) customLog('error', `Error to export collection: ${col}`);

  progressBar.increment();
  logger.info(`Exported: ${col}`);
  return col;
};

const createChildProcessToRestore = async (
  uri: string,
  dbSrc: string,
  dbDestin: string,
  col: string,
  progressBar: SingleBar,
) => {
  const { exitCode } =
    await $`mongorestore --uri=${uri} --db=${dbDestin} --collection=_dump_${col} temp-dump/${dbSrc}/${col}.bson`
      .nothrow()
      .quiet();

  if (exitCode !== 0) customLog('error', `Error to restore collection: ${col}`);

  progressBar.increment();
  logger.info(`Exported: ${col}`);
  return col;
};

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

const deleteTempExport = (outputExport: string) => {
  fs.rmdirSync(outputExport, { recursive: true });
};

const dropOldCollections = async (client: MongoClient, dbName: string, collections: string[]) => {
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

const renameNewCollections = async (client: MongoClient, dbName: string, collections: string[]) => {
  const db = client.db(dbName);
  const limiter = new Bottleneck({ maxConcurrent: 10 });
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

const initDump = async (options: DumpYmlOptions, outputExport: string, limiter: Bottleneck) => {
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
  progressBarExport.stop();
  customLog('success', `Dumped collections: ${solvedExports.join(', ')}\n`);
  return solvedExports;
};

const initRestore = async (options: DumpYmlOptions, collections: string[], limiter: Bottleneck) => {
  const { dump } = options.command;
  customLog('info', 'Init import collections...');
  const progressBarImport = createSingleBar(collections.length, 'Import progress');

  const importCollectionsPromises = collections.map((col) =>
    limiter.schedule(() =>
      createChildProcessToRestore(
        dump.destination.uri,
        dump.source.db,
        dump.destination.db,
        col,
        progressBarImport,
      ),
    ),
  );

  const solvedImports = await Promise.all(importCollectionsPromises);
  progressBarImport.stop();
  customLog('success', `Imported collections: ${solvedImports.join(', ')}\n`);
  return solvedImports;
};

const initRegistrationSync = async (
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

const dumpDbFn = async (ymlpath: string, option: OptionsCli) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-dump');
  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);

  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;
  const limiter = new Bottleneck({ maxConcurrent: option.parallel ?? 3 });

  /**
   *
   * ? DUMP COLLECTIONS
   */
  const dumpedCollections = await initDump(options, outputExport, limiter);

  /**
   *
   * ? RESTORE COLLECTIONS
   */
  const restoredCollections = await initRestore(options, dumpedCollections, limiter);

  /**
   *
   * ? CONNECT TO DESTINATION
   */
  const client = await conn(dump.destination.uri);

  /**
   *
   * ? SET STATE ON __SYNC__ COLLECTION
   */
  await initRegistrationSync(options, restoredCollections, client);

  /**
   *
   * ? CLEAN LOCAL REGISTRES (GENERATED FOR initDump)
   */
  deleteTempExport(outputExport);

  /**
   *
   * ? DROP ON DATABASE ALL COLLECTIONS DUMPED
   */
  await dropOldCollections(client, dump.destination.db, dump.collections);

  /**
   *
   * ? REMOVE ON DESTINATION DATABASE ALL _dump_ PREFIX ON RESTORED COLLECTIONS
   */
  await renameNewCollections(client, dump.destination.db, dump.collections);

  /**
   *
   * ? CLOSE MONGODB CONNECTION
   */
  client.close();
};

export default dumpDbFn;
