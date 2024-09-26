import { errorHandler } from '../errors/error-handler';
import parseYml from '../utils/parse-yml';
import fs from 'fs';
import path from 'path';
import Bottleneck from 'bottleneck';
import { createSingleBar } from '../utils/create-progress-bar';
import type { SingleBar } from 'cli-progress';
import logger, { customLog } from '../utils/custom-log';

const limiter = new Bottleneck({
  maxConcurrent: 2,
});

const createChildProcessToExport = async (
  uri: string,
  db: string,
  col: string,
  progressBar: SingleBar,
): Promise<string | never> => {
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-export');
  if (!fs.existsSync(outputExport)) fs.mkdirSync(outputExport);
  return new Promise(async (resolve) => {
    const child = Bun.spawn([
      'mongoexport',
      `--db=${db}`,
      `--uri=${uri}`,
      `--collection=${col}`,
      `--out=${outputExport}/$${col}.json`,
      '--type=json',
      '--quiet',
    ]);

    await child.exited;
    if (child.killed && child.exitCode === 0) {
      progressBar.increment();

      return resolve(col);
    } else customLog('error', `Error to export collection: ${col}`);
  });
};

const dumpDbFn = async (ymlpath: string) => {
  const options = parseYml<DumpYmlOptions>(ymlpath);

  const { dump } = options.command;

  customLog('info', 'Init collections export...');

  const progressBar = createSingleBar(dump.collections.length);

  const promises = dump.collections.map((col) =>
    limiter.schedule(() =>
      createChildProcessToExport(dump.source.uri, dump.source.db, col, progressBar),
    ),
  );

  const results = await Promise.all(promises);
  progressBar.stop();
  customLog('success', `Exported collections: ${results.join(', ')}`);
};

export default dumpDbFn;
