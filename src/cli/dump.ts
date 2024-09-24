import { errorHandler } from '../errors/error-handler';
import parseYml from '../utils/parse-yml';

// const exportCollections = (col) => {
//   const outputExport = path.resolve('src', 'output', 'saidaExport', `${col}.json`);
//   return new Promise((resolve, reject) => {
//     const child = spawn('mongoexport', [
//       `--uri=${uriMongoDev}`,
//       `--collection=${col}`,
//       `--out=${outputExport}`,
//       '--type=json',
//       '-vvv',
//     ]);

//     child.on('close', (code) => {
//       if (code === 0) {
//         progressBar.increment();
//         resolve();
//       } else {
//         reject(new Error(`Processo ${child.pid} falhou com o código ${code}`));
//       }
//     });

//     child.on('error', (err) => {
//       reject(err);
//     });

//     child.on('exit', (code) => {
//       fs.appendFile(
//         path.resolve('src', 'output', 'logs', '.log'),
//         `Collection: ${col} exportada!\n`,
//       );
//       arr.push({
//         'Collection name': col,
//         'Código de conclusao': code,
//         'ProcessID(PID)': child.pid,
//       });
//     });
//   });
// };

const dumpDbFn = (ymlpath: string) => {
  const options = parseYml<DumpYmlOptions>(ymlpath);
  console.log(options.command.dump);
};

export default dumpDbFn;
