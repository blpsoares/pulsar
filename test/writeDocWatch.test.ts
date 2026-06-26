import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { watchInsertEvent } from "../src/core/sync/insertEvent";
import { watchUpdateEvent } from "../src/core/sync/updateEvent";
import { setLogConfig } from "../src/utils/logConfig";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	setLogConfig({ verbose: false, progress: false });
	client = await connect(DST_URI);
	dbName = uniqueDbName("wdwatch");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

beforeEach(async () => {
	await db.dropDatabase();
});

describe("watch handlers escrevem __migratedAt imutável", () => {
	test("insert grava __migratedAt; update posterior preserva", async () => {
		await watchInsertEvent(db.collection("c"), { _id: 1 as any, v: 1 });
		const first = await db.collection("c").findOne({ _id: 1 as any });
		expect(first?.__migratedAt).toBeInstanceOf(Date);
		const at = (first?.__migratedAt as Date).getTime();

		await new Promise((r) => setTimeout(r, 15));
		await watchUpdateEvent(db.collection("c"), { _id: 1 as any, v: 2 });
		const second = await db.collection("c").findOne({ _id: 1 as any });
		expect(second?.v).toBe(2);
		expect((second?.__migratedAt as Date).getTime()).toBe(at);
		expect(second?.origin).toBe("watch:update");
	});
});
