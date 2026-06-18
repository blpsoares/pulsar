import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import {
	clearDumpCompleted,
	loadSyncState,
	markDumpCompleted,
	saveResumeToken,
} from "../src/core/sync/syncState";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("state");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("syncState (__sync no destino)", () => {
	test("loadSyncState retorna {} quando não existe", async () => {
		const s = await loadSyncState(db, "naoexiste");
		expect(s).toEqual({});
	});

	test("markDumpCompleted grava dumpCompletedAt", async () => {
		await markDumpCompleted(db, "colA", 1000);
		const s = await loadSyncState(db, "colA");
		expect(s.dumpCompletedAt).toBe(1000);
	});

	test("saveResumeToken grava e loadSyncState devolve o token igual", async () => {
		const token = { _data: "82ABCD" };
		await saveResumeToken(db, "colB", token, 2000);
		const s = await loadSyncState(db, "colB");
		expect(s.resumeToken).toEqual(token);
	});

	test("saveResumeToken não apaga dumpCompletedAt já existente", async () => {
		await markDumpCompleted(db, "colC", 3000);
		await saveResumeToken(db, "colC", { _data: "8211" }, 3100);
		const s = await loadSyncState(db, "colC");
		expect(s.dumpCompletedAt).toBe(3000);
		expect(s.resumeToken).toEqual({ _data: "8211" });
	});

	test("clearDumpCompleted remove dumpCompletedAt mas preserva token", async () => {
		await markDumpCompleted(db, "colD", 4000);
		await saveResumeToken(db, "colD", { _data: "8222" }, 4100);
		await clearDumpCompleted(db, "colD");
		const s = await loadSyncState(db, "colD");
		expect(s.dumpCompletedAt).toBeUndefined();
		expect(s.resumeToken).toEqual({ _data: "8222" });
	});
});
