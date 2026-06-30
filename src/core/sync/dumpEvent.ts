// biome-ignore assist/source/organizeImports: <explanation>
import type { AnyBulkWriteOperation, Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { buildReplaceWithMigratedAt } from "./writeDoc";
import { customLog, fileLog } from "../../utils/customLog";
import { t } from "../../utils/i18n";
import { getLogConfig } from "../../utils/logConfig";
import {
	createBar,
	isStatusReporterActive,
	markDone,
	trackDumpDone,
	trackDumpProgress,
	trackDumpStart,
} from "../../utils/progressManager";
import { watcher } from "./watcherEvents";

const DEFAULT_BATCH_SIZE = 500;
const LOG_EVERY = 2000;
const DEFAULT_MAX_RETRIES = 30;
const DEFAULT_RETRY_BASE_MS = 2000;
const MAX_BACKOFF_MS = 30000;

/**
 * Erro de dump que vale RETENTAR (conexão/rede/failover) — vs. erro lógico que
 * não melhora repetindo. Cobre o ECONNREFUSED de um nó do Atlas que cai, reset
 * de socket, server selection, cursor morto no getMore, etc.
 */
function isTransientDumpError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; code?: number | string; message?: string };
	const name = String(e.name ?? "");
	const msg = String(e.message ?? "");
	if (/Mongo(Network|ServerSelection|PoolCleared|NotPrimary)/i.test(name))
		return true;
	if (
		e.code === "ECONNREFUSED" ||
		e.code === "ECONNRESET" ||
		e.code === "ETIMEDOUT"
	)
		return true;
	return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|connection|socket|topology|server selection|not primary|getMore|CursorNotFound|connection pool/i.test(
		msg,
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DumpOptions = {
	filter?: Document;
	batchSize?: number;
	/** Retoma um dump incompleto: só varre docs com `_id < resumeFromId`. */
	resumeFromId?: unknown;
	/** Chamado após cada lote com o menor `_id` já processado (a fronteira). */
	onProgress?: (lastId: unknown) => void;
	/** Chamado ao concluir o dump com as stats finais (p/ o painel de fechamento). */
	onDone?: (info: {
		total: number;
		inserted: number;
		updated: number;
		skipped: number;
	}) => void;
};

export async function dumpCollections(
	sourceCollection: Collection,
	destCollection: Collection,
	deletedIds: string[],
	opts: DumpOptions = {},
): Promise<boolean> {
	const { filter, resumeFromId, onProgress } = opts;
	const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
	const { collectionName } = destCollection;
	const { progress } = getLogConfig();
	const maxRetries =
		Number(process.env.DUMP_MAX_RETRIES) || DEFAULT_MAX_RETRIES;
	const retryBaseMs =
		Number(process.env.DUMP_RETRY_BASE_MS) || DEFAULT_RETRY_BASE_MS;
	let bar: ReturnType<typeof createBar> | null = null;

	const baseFilter = filter ?? {};
	const stats = { skipped: 0, updated: 0, inserted: 0 };
	let processed = 0;
	let lastLogged = 0;
	// Fronteira VIVA: menor _id já processado. Avança a cada lote e é o ponto de
	// retomada tanto entre restarts quanto entre RETRIES dentro do mesmo run.
	let frontier: unknown = resumeFromId ?? null;

	try {
		const countQuery =
			frontier != null
				? { $and: [baseFilter, { _id: { $lt: frontier } }] }
				: baseFilter;
		// Sem filtro nem retomada, estimatedDocumentCount (metadados, instantâneo);
		// caso contrário countDocuments (scan real) para o total correto do recorte.
		const total =
			!filter && frontier == null
				? await sourceCollection.estimatedDocumentCount()
				: await sourceCollection.countDocuments(countQuery);

		bar = progress ? createBar(collectionName, total) : null;
		// alimenta o STATUS heartbeat (visível no docker logs em não-TTY)
		trackDumpStart(collectionName, total);

		if (!bar) {
			const resumeMsg =
				frontier != null
					? t("dump.start_resume_suffix", { frontier: String(frontier) })
					: "";
			customLog(
				"info",
				t("dump.start", { coll: collectionName, total, resume: resumeMsg }),
			);
		}

		const flush = async (page: Document[]) => {
			if (page.length === 0) return;
			await processBatch(page, destCollection, deletedIds, stats);
			processed += page.length;
			trackDumpProgress(collectionName, processed, total);
			// Cursor varre _id desc → o último doc do lote tem o menor _id visto.
			frontier = page[page.length - 1]._id;
			bar?.increment(page.length, {
				skip: stats.skipped,
				upd: stats.updated,
				ins: stats.inserted,
			});
			if (!bar && processed - lastLogged >= LOG_EVERY) {
				lastLogged = processed;
				// Quando o STATUS heartbeat (não-TTY) está ativo, o painel já cobre o
				// progresso no stdout — a linha vira só histórico no arquivo (evita a
				// redundância no `docker logs`). Sem heartbeat, mantém no stdout.
				const logProgress = isStatusReporterActive() ? fileLog : customLog;
				logProgress(
					"info",
					t("dump.progress", {
						coll: collectionName,
						processed,
						total,
						skip: stats.skipped,
						upd: stats.updated,
						ins: stats.inserted,
					}),
				);
			}
			onProgress?.(frontier);
		};

		// Loop de RETRY: cada tentativa reabre o cursor a partir da fronteira viva.
		// Numa falha transitória (ECONNREFUSED/failover) NÃO desistimos — esperamos
		// (backoff) e continuamos de onde parou, sem re-escanear o que já passou.
		let attempt = 0;
		while (true) {
			try {
				const query =
					frontier != null
						? { $and: [baseFilter, { _id: { $lt: frontier } }] }
						: baseFilter;
				const cursor = sourceCollection.find(query).sort({ _id: -1 });
				let page: Document[] = [];
				for await (const coldDocument of cursor) {
					// nullish, não falsy: um _id legítimo de 0 ou "" não pode ser descartado
					if (coldDocument?._id == null) continue;
					page.push(coldDocument);
					if (page.length >= batchSize) {
						await flush(page);
						page = [];
					}
				}
				await flush(page);

				// GUARDA DE RECONCILIAÇÃO. Um cursor pode encerrar ANTES do fim SEM
				// lançar erro (cursor morto no servidor vindo como "fim limpo", getMore
				// devolvendo cursorId 0 cedo, resume pulando faixa). Sem este check, uma
				// varredura PARCIAL era reportada como dump COMPLETO → markDumpCompleted,
				// e o stream ao vivo nunca reconciliava (só entrega mudança nova, não
				// re-injeta doc pré-existente que o cursor pulou). Foi a causa de perda
				// silenciosa de docs (ex.: collection de 117 copiada com 82, marcada OK).
				// Conferimos que NÃO sobra nada abaixo da fronteira; se sobra, a
				// varredura não terminou: reabrimos da fronteira em vez de marcar completo.
				const remainingQuery =
					frontier != null
						? { $and: [baseFilter, { _id: { $lt: frontier } }] }
						: baseFilter;
				const remaining = await sourceCollection.countDocuments(remainingQuery);
				if (remaining === 0) break; // varredura REALMENTE completa

				if (attempt >= maxRetries) {
					throw new Error(
						t("dump.truncated_error", {
							remaining,
							frontier: String(frontier),
							maxRetries,
							coll: collectionName,
							processed,
						}),
					);
				}
				attempt++;
				customLog(
					"warn",
					t("dump.short_cursor", {
						coll: collectionName,
						remaining,
						frontier: String(frontier),
						attempt,
						maxRetries,
					}),
				);
				// não é falha de rede → reabre imediatamente, sem backoff
			} catch (err) {
				if (!isTransientDumpError(err) || attempt >= maxRetries) throw err;
				attempt++;
				const wait = Math.min(MAX_BACKOFF_MS, retryBaseMs * 2 ** (attempt - 1));
				const reason = err instanceof Error ? err.message : String(err);
				customLog(
					"warn",
					t("dump.retry", {
						coll: collectionName,
						attempt,
						maxRetries,
						frontier: String(frontier),
						wait,
						reason,
					}),
				);
				await sleep(wait);
			}
		}

		opts.onDone?.({
			total,
			inserted: stats.inserted,
			updated: stats.updated,
			skipped: stats.skipped,
		});
		watcher.emit("finishDump", collectionName, total, stats);
		return true;
	} catch (error) {
		watcher.emit("errorDump", error, collectionName);
		return false;
	} finally {
		markDone();
		trackDumpDone(collectionName);
	}
}

/**
 * Processa um lote de documentos da origem:
 * 1. Uma única leitura no destino — `find({ _id: { $in: [...] } })` — trazendo
 *    apenas `__sync.hot` e `__sync.hash` (mapa em memória).
 * 2. Decide doc a doc (mesma regra do modo 1-a-1): ausente → insert; hot ou
 *    hash igual → skip; hash diferente → update.
 * 3. Um único `bulkWrite({ ordered: false })` com as operações necessárias.
 *
 * O update usa o filtro `__sync.hot: { $ne: true }` para NÃO sobrescrever um
 * doc que o change stream marcou como hot na janela entre a leitura do lote e a
 * escrita — preservando a semântica "a versão ao vivo sempre vence".
 */
async function processBatch(
	page: Document[],
	destCollection: Collection,
	deletedIds: string[],
	stats: { skipped: number; updated: number; inserted: number },
) {
	const docs = page.filter((d) => !deletedIds.includes(d._id.toString()));
	if (docs.length === 0) return;

	const ids = docs.map((d) => d._id);
	const existing = await destCollection
		.find(
			{ _id: { $in: ids } },
			{ projection: { "__sync.hot": 1, "__sync.hash": 1 } },
		)
		.toArray();
	const destMap = new Map(existing.map((d) => [d._id.toString(), d]));

	const ops: AnyBulkWriteOperation[] = [];

	for (const coldDocument of docs) {
		const newDocument = addFieldsOnMongoDocument(coldDocument, "dump", false);
		const sourceHash = newDocument.__sync?.hash;
		const destDoc = destMap.get(coldDocument._id.toString());

		if (!destDoc) {
			ops.push({
				updateOne: {
					filter: { _id: coldDocument._id },
					update: buildReplaceWithMigratedAt(newDocument),
					upsert: true,
				},
			});
			stats.inserted++;
			continue;
		}

		if (destDoc.__sync?.hot === true || destDoc.__sync?.hash === sourceHash) {
			stats.skipped++;
			continue;
		}

		ops.push({
			updateOne: {
				filter: { _id: coldDocument._id, "__sync.hot": { $ne: true } },
				update: buildReplaceWithMigratedAt(newDocument),
			},
		});
		stats.updated++;
	}

	if (ops.length > 0) {
		await destCollection.bulkWrite(ops, { ordered: false });
	}
}
