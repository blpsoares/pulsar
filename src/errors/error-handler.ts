import { MongoParseError, MongoError } from 'mongodb';
import { customLog } from '../utils/responses.chalk';

export const errorHandler = (err: unknown, breadcrumb: string | object = ''): Promise<never> => {
  if (err instanceof MongoParseError) {
    customLog('error', `MongoParseError: ${breadcrumb} - ${err.message}`);
  }
  if (err instanceof MongoError) {
    customLog('error', `MongoError:${breadcrumb} - ${err.message}`);
  }
  if (err instanceof Error) {
    customLog('error', `${breadcrumb} - ${err.message}`);
  } else {
    customLog('error', `Unknown error: ${err}`);
  }

  process.exit(1);
};
