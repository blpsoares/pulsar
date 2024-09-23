import { MongoClient } from 'mongodb';
import { customLog } from '../utils/responses.chalk';
import { errorHandler } from '../errors/error-handler';
export const conn = async (): Promise<MongoClient | void> => {
  const { MONGO_URI } = process.env;

  if (!MONGO_URI) throw new Error('Mongo URI not declared or is empty');

  customLog('info', 'Connecting to MongoDB...');

  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    customLog('success', 'Connected to MongoDB!');
    return client;
  } catch (error) {
    errorHandler(error, 'conn:mongo:client');
  }
};
