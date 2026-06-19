import { MongoClient, MongoParseError } from "mongodb";
import { errorHandler } from "../errors/errorHandler";
import { customLog, logger } from "../utils/customLog";
export const conn = async (uri: string, source: string = "->") => {
	if (uri.endsWith("/")) uri = uri.slice(0, -1);
	if (!uri) {
		logger.error(uri);
		throw errorHandler(
			new MongoParseError(`Mongo URI not declared or is empty: uri=${uri}`),
			"CONN:MONGO:URI",
		);
	}
	customLog("info", "Connecting to MongoDB...");

	try {
		const client = new MongoClient(uri, {
			retryReads: true,
			retryWrites: true,
			serverSelectionTimeoutMS: 30000,
			connectTimeoutMS: 30000,
			// cursores de dump podem ficar abertos por muito tempo; 0 = sem timeout
			socketTimeoutMS: 0,
			// TETO de conexões por client (origem e destino são clients separados).
			// Com o db.watch ÚNICO, a escuta usa só 1 conexão presa na origem; o resto
			// (dumps/writes) reusa o pool. Por isso dá p/ um teto baixo: origem ~ 1
			// stream + `parallel` dumps; destino ~ writes/checkpoints. 30 sobra e
			// mantém o pulsar como inquilino educado no Atlas compartilhado (era 250 →
			// explodia p/ 400-950 conexões com os antigos 55 streams).
			maxPoolSize: 30,
			// libera conexões ociosas mais rápido p/ não segurar slots do cluster.
			maxIdleTimeMS: 30000,
		});
		await client.connect();
		customLog("success", `Connected to ${source} MongoDB!`);
		return client;
	} catch (error) {
		customLog(
			"error",
			`Can't connect to MongoDB, please verify your credentials or see logs on /src/logs/error.log`,
		);
		logger.error(uri);
		throw errorHandler(error, "CONN:MONGO:CLIENT");
	}
};
