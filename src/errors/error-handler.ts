import { MongoParseError, MongoError } from 'mongodb';
import { YmlToJsonError } from '../types/errors-class';
import { CustomError } from '../types/errors-class';

export const errorHandler = (err: unknown, breadcrumb: string = 'NO:BREADCRUMB') => {
  let errorMessage = '';

  if (err instanceof MongoParseError) {
    errorMessage = `Mongo Parse Error: ${err.message}`;
  } else if (err instanceof MongoError) {
    errorMessage = `Mongo Error: ${err.message}`;
  } else if (err instanceof YmlToJsonError) {
    errorMessage = `Yml To Json Error: ${err.message}`;
  } else if (err instanceof Error) {
    errorMessage = `Error: ${err.message}`;
  } else {
    errorMessage = `Unknown Error: ${String(err)}`;
  }

  throw new CustomError(errorMessage, breadcrumb).logError();
};
