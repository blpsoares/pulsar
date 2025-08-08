import fs from 'fs';
import path from 'path';
import { conn } from '../db/conn';
import Bottleneck from 'bottleneck';
import parseYml from '../utils/parseYml';
import { initDump } from '../operations/dumpCli/dump';
import { deleteTempFolder } from '../utils/deleteTempFolder';
import { initRestore } from '../operations/dumpCli/restoreDump';
import { initRegistrationSync } from '../operations/dumpCli/initSync';
import { dropOldCollections } from '../operations/dumpCli/dropOldCollections';
import { renameNewCollections } from '../operations/dumpCli/renameCollections';
import { customLog } from '../utils/customLog';

const migrateCollections = async (ymlpath: string, cliParams: OptionsCli) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-dump');

  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);

  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;
  const limiter = new Bottleneck({ maxConcurrent: cliParams.parallel ?? 2 });

  /**
   *
   * ? DUMP COLLECTIONS
   */
  const [successExports, failedExports] = await initDump(
  dump.source,
  outputExport,
  limiter,
  dump.collections,
  dump.queryString,
  cliParams.maxRetries
  );

  if (failedExports.length > 0) {
    customLog('error', `Failed to restore collections: ${failedExports}`);
    return;
  };

  /**
   *
   * ? RESTORE COLLECTIONS
   */
    const [successRestores, failedRestores] = await initRestore(
      options,
      successExports,
      limiter,
      cliParams.maxRetries
    );

  if (failedRestores.length > 0) {
    customLog('error', `Failed to restore collections: ${failedRestores}`);
      return;
  };

  /**
   *
   * ? CONNECT TO DESTINATION
   */
  const client = await conn(dump.destination.uri, 'destination');

  /**
   *
   * ? SET STATE ON __SYNC__ COLLECTION
   */
  const [successColds, failedColds] = await initRegistrationSync(
    options,
    successRestores,
    client,
    limiter,
  );

  if (failedColds.length > 0) {
    customLog('info', 'Retrying set cold stats on failed collections');

    let [newSuccessColds] = await initRegistrationSync(options, failedColds, client, limiter);
    successColds.push(...newSuccessColds);
  }

  /**
   *
   * ? DROP ON DATABASE ALL COLLECTIONS DUMPED
   */
  const [successDrops, failedDrops] = await dropOldCollections(
    client,
    dump.destination.db,
    successColds,
    limiter,
  );
  if (failedDrops.length > 0) {
    customLog('info', 'Retrying drop failed collections');

    const [newSuccessDrops] = await dropOldCollections(
      client,
      dump.destination.db,
      failedDrops,
      limiter,
    );
    successDrops.push(...newSuccessDrops);
  }

  /**
   *
   * ? REMOVE ON DESTINATION DATABASE ALL _dump_ PREFIX ON RESTORED COLLECTIONS
   */
  await renameNewCollections(client, dump.destination.db, successDrops, limiter);

  /**
   *
   * ? CLEAN LOCAL REGISTRES (GENERATED FOR dumpCollections)
   */
  deleteTempFolder(outputExport);

  /**
   *
   * ? CLOSE MONGODB CONNECTION
   */
  client.close();
};

export default migrateCollections;
