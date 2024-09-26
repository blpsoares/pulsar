import { errorHandler } from '../errors/error-handler';
import parseYml from '../utils/parse-yml';
import fs from 'fs';
import path from 'path';
import Bottleneck from 'bottleneck';
import { createSingleBar } from '../utils/create-progress-bar';
import type { SingleBar } from 'cli-progress';
import logger, { customLog } from '../utils/custom-log';
import { conn } from '../db/conn';
import type { MongoClient } from 'mongodb';

// TODO: move three database ops to new folder
/**
 // TODO -> add error handler on:
 *  todo -> createChildProcessToExport,
 *  todo -> createChildProcessToImport,
 *  todo -> createSyncStatsOnDestinDb,
 *  todo -> dropOldCollections
 *  todo -> and renameNewCollections
 */

const createChildProcessToExport = async (
  uri: string,
  db: string,
  col: string,
  outputExport: string,
  progressBar: SingleBar,
): Promise<string | never> => {
  return new Promise(async (resolve) => {
    const child = Bun.spawn([
      'mongoexport',
      `--db=${db}`,
      `--uri=${uri}`,
      `--collection=${col}`,
      `--out=${outputExport}/${col}.json`,
      '--type=json',
      '--quiet',
    ]);

    await child.exited;
    if (child.killed && child.exitCode === 0) {
      progressBar.increment();
      logger.info(`Exported: ${col}`);
      return resolve(col);
    } else customLog('error', `Error to export collection: ${col}`);
  });
};

const createChildProcessToImport = async (
  uri: string,
  db: string,
  col: string,
  outputExport: string,
  progressBar: SingleBar,
): Promise<string | never> => {
  return new Promise(async (resolve, reject) => {
    const child = Bun.spawn([
      'mongoimport',
      `--db=${db}`,
      `--uri=${uri}`,
      `--collection=_dump_${col}`,
      `--file=${outputExport}/${col}.json`,
      '--quiet',
    ]);

    await child.exited;
    if (child.killed && child.exitCode === 0) {
      progressBar.increment();
      logger.info(`imported : ${col}`);
      return resolve(col);
    } else {
      customLog('error', `Error to import collection: ${col}`);
      const text = await new Response(child.stdout).text();
      logger.error(
        `Error to import collection: ${col}
        \nExit code: ${child.exitCode}
        \nOutput: ${text}
        `,
      );
      reject();
    }
  });
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
  await Promise.all(promises);
  customLog('success', 'Dropped old collections\n');
};

const renameNewCollections = async (client: MongoClient, dbName: string, collections: string[]) => {
  const db = client.db(dbName);
  const limiter = new Bottleneck({ maxConcurrent: 10 });
  customLog('info', 'Rename all new collections...');
  const promises = collections.map((col) =>
    limiter.schedule(() => db.renameCollection(`_dump_${col}`, col)),
  );
  await Promise.all(promises);
  customLog('success', 'Renamed all new collections \n');
};

// TODO: See codes that repeat logic and create a function to modularize and clean up the main function
const dumpDbFn = async (ymlpath: string, option: OptionsCli) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-export');
  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);

  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;

  const limiter = new Bottleneck({ maxConcurrent: option.parallel ?? 3 });

  //* EXPORT COLLECTIONS
  customLog('info', 'Init export collections...');
  const progressBarExport = createSingleBar(dump.collections.length, 'Export progress ');

  const exportCollectionsPromises = dump.collections.map((col) =>
    limiter.schedule(() =>
      createChildProcessToExport(
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
  customLog('success', `Exported collections: ${solvedExports.join(', ')}\n`);

  //* IMPORT COLLECTIONS
  customLog('info', 'Init import collections...');
  const client = await conn();
  const progressBarImport = createSingleBar(dump.collections.length, 'Import progress');

  const importCollectionsPromises = solvedExports.map((col) =>
    limiter.schedule(() =>
      createChildProcessToImport(
        dump.destination.uri,
        dump.destination.db,
        col,
        outputExport,
        progressBarImport,
      ),
    ),
  );
  const solvedImports = await Promise.all(importCollectionsPromises);
  progressBarImport.stop();
  customLog('success', `Imported collections: ${solvedImports.join(', ')}\n`);

  //* SET STATE ON __SYNC__ COLLECTION
  customLog('info', 'Init set state on __sync__ collection...');
  const progressBarColdState = createSingleBar(dump.collections.length, 'Set cold state');
  const solvedSetColdState = solvedExports.map((col) =>
    createSyncStatsOnDestinDb(client, dump.destination.db, col, progressBarColdState),
  );

  await Promise.all(solvedSetColdState);
  progressBarColdState.stop();
  customLog('success', 'Setted cold state on documents in __sync__ collection\n');

  deleteTempExport(outputExport);

  await dropOldCollections(client, dump.destination.db, dump.collections);

  await renameNewCollections(client, dump.destination.db, dump.collections);

  client.close();
};

export default dumpDbFn;
