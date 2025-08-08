import fs from 'fs';
import yaml from 'js-yaml';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { errorHandler } from '../errors/errorHandler';
import { customLog } from './customLog';

const parseYml = <T>(ymlPath: string, schema: ZodType<T>): T => {
  if (!fs.existsSync(ymlPath)) {
    throw errorHandler(new Error(`File not found on path: ${ymlPath}`));
  }

  const yml = fs.readFileSync(ymlPath, 'utf-8');
  const rawData = yaml.load(yml);

  if (!rawData) {
    throw errorHandler(new Error('YML file is empty or malformed'));
  }

  try {
    return schema.parse(rawData);
  } catch (err) {
    if (err instanceof ZodError) {
      throw errorHandler(err, "PARSE:YML:ZOD")
    }
    throw err;
  }
};

export default parseYml;
