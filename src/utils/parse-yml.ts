import yaml from 'js-yaml';
import fs from 'fs';
import { errorHandler } from '../errors/error-handler';
import { YmlToJsonError } from '../classes/errors-class';

const parseYml = <T>(ymlPath: string): T => {
  if (!fs.existsSync(ymlPath)) {
    throw errorHandler(new YmlToJsonError('ENOENT no such file or directory'), 'FS:YML:PARSE-FN');
  }

  const yml = fs.readFileSync(ymlPath);

  const options = yaml.load(yml.toString());

  if (!options) {
    throw errorHandler(new YmlToJsonError('YML file can not empty'), 'OPTIONS:LOAD:YML');
  }

  return options as T;
};

export default parseYml;
