import { MongoClient, MongoParseError } from "mongodb";
import { errorHandler } from "../errors/errorHandler";
import { customLog, logger } from "../utils/customLog";
import { t } from "../utils/i18n";
export const conn = async (uri: string, source: string = "->") => {
	if (uri.endsWith("/")) uri = uri.slice(0, -1);
	if (!uri) {
		logger.error(uri);
		throw errorHandler(
			new MongoParseError(t("conn.uri_empty", { uri })),
			"CONN:MONGO:URI",
		);
	}
	customLog("info", t("conn.connecting"));

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
		// client.connect() resolve de forma OTIMISTA: o driver v6 retorna sem garantir
		// um handshake real com o mongod, então um IP fora da allowlist do Atlas (ou
		// 27017 bloqueada) passava como "Connected" e só estourava 50 erros crípticos
		// lá no mongodump. O ping força um round-trip de verdade — falha aqui, com
		// mensagem clara, em vez de mentir sucesso.
		await client.db().command({ ping: 1 });
		customLog("success", t("conn.connected", { source }));
		return client;
	} catch (error) {
		customLog("error", t("conn.unreachable", { source }));
		logger.error(uri);
		throw errorHandler(error, "CONN:MONGO:CLIENT");
	}
};
