import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import {
	clearDumpProgress,
	loadSyncState,
	markDumpCompleted,
	saveDumpProgress,
} from "../src/core/sync/syncState";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("dprog");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("syncState — progresso do dump (fronteira do cursor)", () => {
	test("saveDumpProgress grava dumpCursorId e loadSyncState devolve", async () => {
		await saveDumpProgress(db, "colA", 42000, 1000);
		const s = await loadSyncState(db, "colA");
		expect(s.dumpCursorId).toBe(42000);
	});

	test("saveDumpProgress atualiza pra fronteira mais nova", async () => {
		await saveDumpProgress(db, "colB", 90000, 1000);
		await saveDumpProgress(db, "colB", 50000, 1100);
		const s = await loadSyncState(db, "colB");
		expect(s.dumpCursorId).toBe(50000);
	});

	test("markDumpCompleted limpa a fronteira (dump terminou, não precisa retomar)", async () => {
		await saveDumpProgress(db, "colC", 7000, 1000);
		await markDumpCompleted(db, "colC", 2000);
		const s = await loadSyncState(db, "colC");
		expect(s.dumpCompletedAt).toBe(2000);
		expect(s.dumpCursorId).toBeUndefined();
	});

	test("clearDumpProgress remove a fronteira", async () => {
		await saveDumpProgress(db, "colD", 3000, 1000);
		await clearDumpProgress(db, "colD");
		const s = await loadSyncState(db, "colD");
		expect(s.dumpCursorId).toBeUndefined();
	});
});
