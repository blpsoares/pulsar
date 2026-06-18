// biome-ignore assist/source/organizeImports: <explanation>

import type {
	ChangeStreamDocument,
	Collection,
	Db,
	Document,
	ResumeToken,
} from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { dumpCollections } from "./dumpEvent";
import { watcher } from "./watcherEvents";
import { customLog, logger } from "../../utils/customLog";
import { logAboveBars } from "../../utils/progressManager";
import { getLogConfig } from "../../utils/logConfig";
import { transformFilterForChangeStream } from "../../utils/mongo";

export const acceptableEventOperations = [
	"insert",
	"update",
	"delete",
	"replace",
];

const deletedIds: string[] = [];

/**
 * FASE 1 — freeze + abre o change stream da collection. É leve e roda para
 * TODAS as collections antes dos dumps, garantindo que o watch ao vivo esteja
 * ativo desde o início. Sem isso, com paralelismo baixo, uma collection grande
 * em dump bloquearia a abertura dos watches das demais e perderíamos eventos.
 */
export async function startWatch(
	collectionName: string,
	sourceDb: Db,
	destDb: Db,
	filter?: Document,
) {
	const sourceCollection = sourceDb.collection(collectionName);
	const destCollection = destDb.collection(collectionName);

	// freeze ANTES de abrir o stream: limpa hot velho sem risco de apagar um
	// hot que o próprio stream venha a marcar nesta run.
	await freezeCollection(destCollection);

	const pipeline = filter
		? [{ $match: { $or: [{ operationType: "delete" }, transformFilterForChangeStream(filter)] } }]
		: [];
	openChangeStream(sourceCollection, destCollection, pipeline);
	logger.info(`watch ativo [${collectionName}]`);
}

/**
 * FASE 2 — dump inicial (cursor + batch). É a parte pesada, throttled pelo -p.
 * O change stream desta collection já está ativo (fase 1), então qualquer
 * mudança ao vivo durante o dump é capturada normalmente.
 */
export async function dumpOnly(
	collectionName: string,
	sourceDb: Db,
	destDb: Db,
	filter?: Document,
	batchSize?: number,
) {
	const sourceCollection = sourceDb.collection(collectionName);
	const destCollection = destDb.collection(collectionName);

	logger.info(`dump start [${collectionName}]`);
	// Com barra ativa, a própria barra já é o indicador do dump; a linha extra
	// só embaralharia o redraw. Mostra no terminal apenas quando não há barra.
	if (!getLogConfig().progress) {
		logAboveBars(`▶ dump [ ${collectionName} ] (contagem + cursor)...`);
	}

	await dumpCollections(sourceCollection, destCollection, deletedIds, filter, batchSize);
}

/**
 * Abre o change stream e o reabre automaticamente em caso de erro (queda de
 * conexão, etc.). Em vez de derrubar o processo, loga e reagenda a reabertura
 * usando o último resume token para não perder eventos no intervalo.
 */
function openChangeStream(
	sourceCollection: Collection,
	destCollection: Collection,
	pipeline: Document[],
	resumeAfter?: ResumeToken,
) {
	const { collectionName } = sourceCollection;
	const changeStream = sourceCollection.watch(pipeline, {
		fullDocument: "updateLookup",
		...(resumeAfter ? { startAfter: resumeAfter } : {}),
	});

	let lastToken: ResumeToken | undefined = resumeAfter;

	changeStream.on("change", (change) => {
		lastToken = change._id;
		delegateEvent(change, destCollection, deletedIds);
	});

	changeStream.on("error", (err) => {
		const message = err instanceof Error ? err.message : String(err);
		customLog(
			"error",
			`Change stream [ ${collectionName} ] caiu: ${message}. Reabrindo em 5s...`,
			true,
		);
		logger.error(`WATCH:${collectionName} ${message}`);
		changeStream.close().catch(() => {});
		setTimeout(() => {
			openChangeStream(sourceCollection, destCollection, pipeline, lastToken);
		}, 5000);
	});
}

function delegateEvent(
	change: ChangeStreamDocument,
	destCollection: Collection,
	deletedIds: string[],
) {
	const { operationType } = change;
	switch (operationType) {
		case "insert":
			watcher.emit("insert", destCollection, change.fullDocument);
			break;
		case "update":
			watcher.emit("update", destCollection, change.fullDocument);
			break;
		case "delete":
			watcher.emit(
				"delete",
				change.documentKey._id,
				destCollection,
				deletedIds,
			);
			break;
		case "replace":
			watcher.emit("replace", destCollection, change.fullDocument);
			break;
		default:
			break;
	}
}
