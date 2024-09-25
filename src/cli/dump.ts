import { errorHandler } from '../errors/error-handler';
import parseYml from '../utils/parse-yml';
import fs from 'fs';
import path from 'path';
import Bottleneck from 'bottleneck';
import { createSingleBar } from '../utils/create-progress-bar';
import type { SingleBar } from 'cli-progress';
import { customLog } from '../utils/responses.chalk';
const limiter = new Bottleneck({
  maxConcurrent: 2,
});

// const { dump } = dumpProps.command;
// if (!dump) errorHandler(new Error('Missing dump key on dumpProps object'), 'CHILD-PROC:EXPORT');
const createChildProcessToExport = async (
  uri: string,
  db: string,
  col: string,
  // progressBar: SingleBar,
) => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-export');
  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);
  return new Promise(async (resolve, reject) => {
    const child = Bun.spawn([
      'mongoexport',
      `--db=${db}`,
      `--uri=${uri}`,
      `--collection=${col}`,
      `--out=${outputExport}/$${col}.json`,
      '--type=json',
      '--quiet',
    ]);
    if (child.killed && child.exitCode === 0) {
      console.log(`terminou a col ${col}`);
      // resolve(col);
      // progressBar.increment();
    }
  });
};

const dumpDbFn = async (ymlpath: string) => {
  const options = parseYml<DumpYmlOptions>(ymlpath);
  const { dump } = options.command;
  customLog('info', 'Init collections export...');
  // const progressBar = createSingleBar(dump.collections.length);
  const promises = dump.collections.map((col) =>
    limiter.schedule(
      () => createChildProcessToExport(dump.source.uri, dump.source.db, col),
      // createChildProcessToExport(dump.source.uri, dump.source.db, col, progressBar),
    ),
  );
  const results = await Promise.all(promises);
  customLog('success', `Exported collections: ${results}`);
  // progressBar.stop();
};

export default dumpDbFn;
