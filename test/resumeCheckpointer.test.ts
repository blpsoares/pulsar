import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, MongoClient, ResumeToken } from "mongodb";
import { ResumeTokenCheckpointer } from "../src/core/sync/resumeCheckpointer";
import { loadSyncState, saveResumeToken } from "../src/core/sync/syncState";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("ckpt");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("ResumeTokenCheckpointer", () => {
	test("flush persiste o token atual lido do getToken", async () => {
		const cur: ResumeToken = { _data: "8201" };
		const c = new ResumeTokenCheckpointer(
			() => cur,
			(t) => saveResumeToken(db, "c1", t),
		);
		await c.flush();
		const s = await loadSyncState(db, "c1");
		expect(s.resumeToken).toEqual({ _data: "8201" });
	});

	test("token null não escreve (collection ainda não estabeleceu)", async () => {
		const c = new ResumeTokenCheckpointer(
			() => null,
			(t) => saveResumeToken(db, "c2", t),
		);
		const wrote = await c.flush();
		expect(wrote).toBe(false);
		expect(await loadSyncState(db, "c2")).toEqual({});
	});

	test("token inalterado não re-escreve", async () => {
		const tok: ResumeToken = { _data: "8211" };
		const c = new ResumeTokenCheckpointer(
			() => tok,
			(t) => saveResumeToken(db, "c3", t),
		);
		expect(await c.flush()).toBe(true);
		expect(await c.flush()).toBe(false);
	});

	test("token que avançou re-escreve o mais novo", async () => {
		let cur: ResumeToken = { _data: "82AA" };
		const c = new ResumeTokenCheckpointer(
			() => cur,
			(t) => saveResumeToken(db, "c4", t),
		);
		await c.flush();
		cur = { _data: "82BB" };
		expect(await c.flush()).toBe(true);
		const s = await loadSyncState(db, "c4");
		expect(s.resumeToken).toEqual({ _data: "82BB" });
	});
});
