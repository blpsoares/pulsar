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
      // TETO de conexões por client (origem e destino são clients separados).
      // Cada change stream segura ~1 conexão presa (long-poll) na origem; os
      // dumps/writes reusam o restante do pool. 250 deixava o número explodir
      // (400-950 conexões no Atlas, sobrecarregando o cluster compartilhado).
      // 80 corta o teto sem starvar os ~55 streams atuais. O alívio definitivo
      // vem de colapsar os 55 streams num único db.watch() (aí dá p/ baixar bem).
      maxPoolSize: 80,
      // libera conexões ociosas mais rápido p/ não segurar slots do cluster.
      maxIdleTimeMS: 30000,
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
