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
): Promise<void> => {
  await client
    .db(db)
    .collection('__sync__')
    .updateOne({ id: col }, { $setOnInsert: { id: col, status: 'cold' } }, { upsert: true });
};

const dumpDbFn = async (ymlpath: string, option: OptionsCli) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-export');
  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);

  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;

  const limiter = new Bottleneck({ maxConcurrent: option.parallel ?? 3 });

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
  customLog('success', `Exported collections: ${solvedExports.join(', ')}`);

  const progressBarImport = createSingleBar(dump.collections.length, 'Import progress');
  customLog('info', 'Init import collections...');

  // createSyncStatsOnDestinDb(client, dump.destination.db, col);

  const client = await conn();
  const solvedImports = solvedExports.map((col) =>
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
  await Promise.all(solvedImports);
  progressBarImport.stop();
  customLog('success', `Imported collections: ${solvedImports.join(', ')}`);
  const solvedSetColdState = solvedExports.map((col) =>
    createSyncStatsOnDestinDb(client, dump.destination.db, col),
  );

  await Promise.all(solvedSetColdState);

  client.close();
};

export default dumpDbFn;

// mongoimport --db="aurora-staging" --uri="mongodb://localdb:27017" --collection="_m_conjuntosLocaisComRegioes" --file="/app/temp-export/_m_conjuntosLocaisComRegioes.json"
