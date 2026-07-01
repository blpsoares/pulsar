import { MongoClient, MongoParseError } from "mongodb";
import { errorHandler } from "../errors/errorHandler";
import { customLog, logger } from "../utils/customLog";
import { t } from "../utils/i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MAX_RETRIES = 60;
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 30000;

/**
 * Erro de CONEXÃO que vale RETENTAR (Atlas pisca, failover, rede, timeout de
 * handshake) — vs. erro de config (URI/auth) que não melhora repetindo.
 *
 * Crítico p/ um daemon 24/7: um `secureConnect timed out` no destino NÃO pode
 * derrubar o processo. Antes: conn() lançava → syncCollections abortava → nada
 * segurava o event loop → exit 0 → Docker reiniciava em LOOP (sem progredir).
 */
export function isTransientConnError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; code?: number | string; message?: string };
	const name = String(e.name ?? "");
	const msg = String(e.message ?? "");
	if (
		/Mongo(ServerSelection|Network|Timeout|PoolCleared|NotPrimary)/i.test(name)
	)
		return true;
	if (
		e.code === "ECONNREFUSED" ||
		e.code === "ECONNRESET" ||
		e.code === "ETIMEDOUT" ||
		e.code === "EAI_AGAIN"
	)
		return true;
	return /timed out|secureConnect|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|topology|server selection|not primary|pool cleared|host closed|connection (closed|reset|refused)/i.test(
		msg,
	);
}

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

	const maxAttempts =
		Number(process.env.PULSAR_CONN_MAX_RETRIES) || DEFAULT_MAX_RETRIES;
	let attempt = 0;
	// Erro TRANSITÓRIO (Atlas/rede) → backoff e tenta de novo, sem matar o
	// processo. Erro de config (URI/auth) → propaga na hora.
	while (true) {
		let client: MongoClient | undefined;
		try {
			client = new MongoClient(uri, {
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
			await client?.close().catch(() => {});
			attempt++;
			if (!isTransientConnError(error) || attempt >= maxAttempts) {
				customLog("error", t("conn.unreachable", { source }));
				logger.error(uri);
				throw errorHandler(error, "CONN:MONGO:CLIENT");
			}
			const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
			const reason = error instanceof Error ? error.message : String(error);
			customLog(
				"warn",
				t("conn.retry", { source, attempt, maxAttempts, wait, reason }),
			);
			await sleep(wait);
		}
	}
};
