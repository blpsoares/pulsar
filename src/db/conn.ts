import { MongoClient, MongoParseError } from 'mongodb';
import { customLog, logger } from '../utils/customLog';
import { errorHandler } from '../errors/errorHandler';
export const conn = async (uri: string, source: string = '->') => {
  if (uri.endsWith('/')) uri = uri.slice(0, -1);
  if (!uri) {
    logger.error(uri);
    throw errorHandler(
      new MongoParseError(`Mongo URI not declared or is empty: uri=${uri}`),
      'CONN:MONGO:URI',
    );
  }
  customLog('info', 'Connecting to MongoDB...');

  try {
    const client = new MongoClient(uri, {
      retryReads: true,
      retryWrites: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      // cursores de dump podem ficar abertos por muito tempo; 0 = sem timeout
      socketTimeoutMS: 0,
      // Cada change stream segura ~1 conexão (long-poll). Com N collections,
      // são N streams + as conexões dos dumps. O pool precisa caber tudo, senão
      // os dumps ficam sem conexão e travam. 250 cobre folgado as ~55 atuais.
      maxPoolSize: 250,
      maxIdleTimeMS: 60000,
    });
    await client.connect();
    customLog('success', `Connected to ${source} MongoDB!`);
    return client;
  } catch (error) {
    customLog(
      'error',
      `Can't connect to MongoDB, please verify your credentials or see logs on /src/logs/error.log`,
    );
    logger.error(uri);
    throw errorHandler(error, 'CONN:MONGO:CLIENT');
  }
};
