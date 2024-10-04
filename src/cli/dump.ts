import fs from 'fs';
import path from 'path';
import { conn } from '../db/conn';
import Bottleneck from 'bottleneck';
import parseYml from '../utils/parse-yml';
import { initDump } from '../operations/dump-cli/dump';
import { deleteTempFolder } from '../utils/delete-temp-folder';
import { initRestore } from '../operations/dump-cli/restore-dump';
import { initRegistrationSync } from '../operations/dump-cli/init-sync';
import { dropOldCollections } from '../operations/dump-cli/drop-old-collections';
import { renameNewCollections } from '../operations/dump-cli/rename-collections';

const dumpDbFn = async (ymlpath: string, option: OptionsCli) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-dump');

  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);

  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;
  const limiter = new Bottleneck({ maxConcurrent: option.parallel ?? 2 });

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
  const settedColds = await initRegistrationSync(options, restoredCollections, client, limiter);

  /**
   *
   * ? DROP ON DATABASE ALL COLLECTIONS DUMPED
   */
  const droppedCollections = await dropOldCollections(
    client,
    dump.destination.db,
    settedColds,
    limiter,
  );

  /**
   *
   * ? REMOVE ON DESTINATION DATABASE ALL _dump_ PREFIX ON RESTORED COLLECTIONS
   */
  await renameNewCollections(client, dump.destination.db, droppedCollections, limiter);

  /**
   *
   * ? CLEAN LOCAL REGISTRES (GENERATED FOR initDump)
   */
  deleteTempFolder(outputExport);

  /**
   *
   * ? CLOSE MONGODB CONNECTION
   */
  client.close();
};

export default dumpDbFn;
