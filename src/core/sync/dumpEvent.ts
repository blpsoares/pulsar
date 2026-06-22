// biome-ignore assist/source/organizeImports: <explanation>
import type { AnyBulkWriteOperation, Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";
import { customLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import {
	createBar,
	markDone,
	trackDumpDone,
	trackDumpProgress,
	trackDumpStart,
} from "../../utils/progressManager";
import { watcher } from "./watcherEvents";

const DEFAULT_BATCH_SIZE = 500;
const LOG_EVERY = 2000;

export type DumpOptions = {
	filter?: Document;
	batchSize?: number;
	/** Retoma um dump incompleto: só varre docs com `_id < resumeFromId`. */
	resumeFromId?: unknown;
	/** Chamado após cada lote com o menor `_id` já processado (a fronteira). */
	onProgress?: (lastId: unknown) => void;
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
	let bar: ReturnType<typeof createBar> | null = null;

	// Query do cursor: filtro do usuário + (se retomando) recorte `_id < fronteira`.
	const baseFilter = filter ?? {};
	const query =
		resumeFromId != null
			? { $and: [baseFilter, { _id: { $lt: resumeFromId } }] }
			: baseFilter;

	try {
		// Sem filtro nem retomada, estimatedDocumentCount (metadados, instantâneo);
		// caso contrário countDocuments (scan real) para o total correto do recorte.
		const total =
			!filter && resumeFromId == null
				? await sourceCollection.estimatedDocumentCount()
				: await sourceCollection.countDocuments(query);
		const stats = { skipped: 0, updated: 0, inserted: 0 };

		bar = progress ? createBar(collectionName, total) : null;
		// alimenta o STATUS heartbeat (visível no docker logs em não-TTY)
		trackDumpStart(collectionName, total);

		// Sem barra (não-TTY/pm2) não há feedback durante o dump; logamos
		// progresso a cada LOG_EVERY docs para dar visibilidade.
		let processed = 0;
		let lastLogged = 0;
		if (!bar) {
			const resumeMsg =
				resumeFromId != null ? ` (retomando de _id<${resumeFromId})` : "";
			customLog(
				"info",
				`dump:start | collection: ${collectionName} | total: ${total}${resumeMsg}`,
			);
		}

		const cursor = sourceCollection.find(query).sort({ _id: -1 });
		let page: Document[] = [];

		const flush = async () => {
			if (page.length === 0) return;
			await processBatch(page, destCollection, deletedIds, stats);
			processed += page.length;
			trackDumpProgress(collectionName, processed, total);
			// Cursor varre _id desc → o último doc do lote tem o menor _id visto.
			const frontier = page[page.length - 1]._id;
			bar?.increment(page.length, {
				skip: stats.skipped,
				upd: stats.updated,
				ins: stats.inserted,
			});
			if (!bar && processed - lastLogged >= LOG_EVERY) {
				lastLogged = processed;
				customLog(
					"info",
					`dump:progress | collection: ${collectionName} | ${processed}/${total} | skip ${stats.skipped} upd ${stats.updated} ins ${stats.inserted}`,
				);
			}
			page = [];
			onProgress?.(frontier);
		};

		for await (const coldDocument of cursor) {
			// nullish, não falsy: um _id legítimo de 0 ou "" não pode ser descartado
			if (coldDocument?._id == null) continue;
			page.push(coldDocument);
			if (page.length >= batchSize) await flush();
		}
		await flush();

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
				replaceOne: {
					filter: { _id: coldDocument._id },
					replacement: newDocument,
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
				update: { $set: newDocument },
			},
		});
		stats.updated++;
	}

	if (ops.length > 0) {
		await destCollection.bulkWrite(ops, { ordered: false });
	}
}
