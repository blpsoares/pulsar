import { MongoClient, MongoParseError } from 'mongodb';
import { customLog } from '../utils/custom-log';
import { errorHandler } from '../errors/error-handler';
export const conn = async (uri: string) => {
  if (!uri) {
    throw errorHandler(
      new MongoParseError(`Mongo URI not declared or is empty: uri=${uri}`),
      'CONN:MONGO:URI',
    );
  }
  customLog('info', 'Connecting to MongoDB...');

  try {
    const client = new MongoClient(uri);
    await client.connect();
    customLog('success', 'Connected to MongoDB!');
    return client;
  } catch (error) {
    customLog(
      'error',
      `Can't connect to MongoDB, please verify your credentials or see logs on /src/logs/error.log`,
    );
    throw errorHandler(error, 'CONN:MONGO:CLIENT');
  }
};
