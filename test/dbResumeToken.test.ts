import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import {
	loadDbResumeToken,
	saveDbResumeToken,
} from "../src/core/sync/syncState";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("dbtok");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("token global do db.watch", () => {
	test("loadDbResumeToken retorna undefined quando não há", async () => {
		expect(await loadDbResumeToken(db)).toBeUndefined();
	});

	test("save e load devolvem o mesmo token", async () => {
		await saveDbResumeToken(db, { _data: "82DEAD" }, 1000);
		expect(await loadDbResumeToken(db)).toEqual({ _data: "82DEAD" });
	});

	test("save atualiza pro token mais novo", async () => {
		await saveDbResumeToken(db, { _data: "82AA" }, 1000);
		await saveDbResumeToken(db, { _data: "82BB" }, 1100);
		expect(await loadDbResumeToken(db)).toEqual({ _data: "82BB" });
	});
});
