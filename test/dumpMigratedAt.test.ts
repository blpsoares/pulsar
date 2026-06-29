import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { dumpCollections } from "../src/core/sync/dumpEvent";
import { setLogConfig } from "../src/utils/logConfig";
import {
	connect,
	DST_URI,
	dropDb,
	SRC_URI,
	seed,
	uniqueDbName,
} from "./helpers";

let srcClient: MongoClient;
let dstClient: MongoClient;
let srcDb: Db;
let dstDb: Db;
let srcName: string;
let dstName: string;

beforeAll(async () => {
	setLogConfig({ verbose: false, progress: false });
	srcClient = await connect(SRC_URI);
	dstClient = await connect(DST_URI);
	srcName = uniqueDbName("dma_src");
	dstName = uniqueDbName("dma_dst");
	srcDb = srcClient.db(srcName);
	dstDb = dstClient.db(dstName);
});

afterAll(async () => {
	await dropDb(srcClient, srcName);
	await dropDb(dstClient, dstName);
	await srcClient.close();
	await dstClient.close();
});

beforeEach(async () => {
	await srcDb.dropDatabase();
	await dstDb.dropDatabase();
});

describe("dump grava __migratedAt", () => {
	test("dump inicial grava __migratedAt Date; re-dump preserva", async () => {
		await seed(srcDb, "c", 5);
		await dumpCollections(srcDb.collection("c"), dstDb.collection("c"), []);
		const first = await dstDb.collection("c").findOne({ _id: 0 as any });
		expect(first?.__migratedAt).toBeInstanceOf(Date);
		const at = (first?.__migratedAt as Date).getTime();

		// muda um doc na origem e re-dumpa: __migratedAt deve ser preservado
		await srcDb
			.collection("c")
			.updateOne({ _id: 0 as any }, { $set: { v: 999 } });
		await new Promise((r) => setTimeout(r, 15));
		await dumpCollections(srcDb.collection("c"), dstDb.collection("c"), []);
		const second = await dstDb.collection("c").findOne({ _id: 0 as any });
		expect(second?.v).toBe(999); // re-dump atualizou o dado
		expect((second?.__migratedAt as Date).getTime()).toBe(at); // data preservada
	});
});
