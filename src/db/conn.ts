import { MongoClient, MongoParseError } from 'mongodb';
import { customLog } from '../utils/custom-log';
import { errorHandler } from '../errors/error-handler';
export const conn = async (): Promise<MongoClient | void> => {
  const { MONGO_URI } = process.env;

  if (!MONGO_URI) {
    throw errorHandler(new MongoParseError('Mongo URI not declared or is empty'), 'CONN:MONGO:URI');
  }
  customLog('info', 'Connecting to MongoDB...');

  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    customLog('success', 'Connected to MongoDB!');
    return client;
  } catch (error) {
    throw errorHandler(error, 'CONN:MONGO:CLIENT');
  }
};
