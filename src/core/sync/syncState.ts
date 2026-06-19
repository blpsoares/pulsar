import type { Db, ResumeToken } from "mongodb";
import type { SyncStateDoc } from "./restartDecision";

/**
 * Collection de controle no destino (já criada pelo `initSync` do migrate).
 * No `sync` guardamos, 1 doc por collection: `{ id, dumpCompletedAt,
 * resumeToken, tokenUpdatedAt }`.
 */
export const SYNC_META_COLLECTION = "__sync";

/** Lê o estado de uma collection. Retorna {} quando não há doc. */
export async function loadSyncState(
	destDb: Db,
	collectionName: string,
): Promise<SyncStateDoc> {
	const doc = await destDb.collection(SYNC_META_COLLECTION).findOne(
		{ id: collectionName },
		{
			projection: {
				_id: 0,
				dumpCompletedAt: 1,
				resumeToken: 1,
				dumpCursorId: 1,
			},
		},
	);
	if (!doc) return {};
	const state: SyncStateDoc = {};
	if (typeof doc.dumpCompletedAt === "number")
		state.dumpCompletedAt = doc.dumpCompletedAt;
	if (doc.resumeToken !== undefined && doc.resumeToken !== null)
		state.resumeToken = doc.resumeToken as ResumeToken;
	if (doc.dumpCursorId !== undefined && doc.dumpCursorId !== null)
		state.dumpCursorId = doc.dumpCursorId;
	return state;
}

/** Carimba que o dump da collection concluiu. Setado uma vez por run completa. */
export async function markDumpCompleted(
	destDb: Db,
	collectionName: string,
	at: number = Date.now(),
): Promise<void> {
	await destDb.collection(SYNC_META_COLLECTION).updateOne(
		{ id: collectionName },
		{
			$setOnInsert: { id: collectionName },
			$set: { dumpCompletedAt: at },
			// Dump terminou: a fronteira não serve mais.
			$unset: { dumpCursorId: "" },
		},
		{ upsert: true },
	);
}

/**
 * Salva a fronteira do cursor de um dump em andamento (menor _id já processado,
 * já que o cursor varre `_id:-1`). No restart de um dump incompleto, retomamos
 * de `find({ _id: { $lt: dumpCursorId } })` em vez de do zero.
 */
export async function saveDumpProgress(
	destDb: Db,
	collectionName: string,
	lastId: unknown,
	at: number = Date.now(),
): Promise<void> {
	await destDb.collection(SYNC_META_COLLECTION).updateOne(
		{ id: collectionName },
		{
			$setOnInsert: { id: collectionName },
			$set: { dumpCursorId: lastId, dumpProgressAt: at },
		},
		{ upsert: true },
	);
}

/** Remove a fronteira do dump. */
export async function clearDumpProgress(
	destDb: Db,
	collectionName: string,
): Promise<void> {
	await destDb
		.collection(SYNC_META_COLLECTION)
		.updateOne({ id: collectionName }, { $unset: { dumpCursorId: "" } });
}

/** Persiste o último resume token visto pelo change stream da collection. */
export async function saveResumeToken(
	destDb: Db,
	collectionName: string,
	token: ResumeToken,
	at: number = Date.now(),
): Promise<void> {
	await destDb.collection(SYNC_META_COLLECTION).updateOne(
		{ id: collectionName },
		{
			$setOnInsert: { id: collectionName },
			$set: { resumeToken: token, tokenUpdatedAt: at },
		},
		{ upsert: true },
	);
}

/** Remove o carimbo de dump concluído (usado em --full e no fallback do 286). */
export async function clearDumpCompleted(
	destDb: Db,
	collectionName: string,
): Promise<void> {
	await destDb
		.collection(SYNC_META_COLLECTION)
		.updateOne({ id: collectionName }, { $unset: { dumpCompletedAt: "" } });
}
