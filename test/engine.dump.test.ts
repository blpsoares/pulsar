import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { SyncEngine } from "../src/core/sync/engine";
import { loadSyncState } from "../src/core/sync/syncState";
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
	srcName = uniqueDbName("dump_src");
	dstName = uniqueDbName("dump_dst");
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

describe("SyncEngine — dump inicial (cold)", () => {
	test("copia todos os docs da origem pro destino com __sync/origin", async () => {
		await seed(srcDb, "colA", 50);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		expect(await dstDb.collection("colA").countDocuments()).toBe(50);
		const d = await dstDb.collection("colA").findOne({ _id: 0 as any });
		expect(d?.origin).toBe("dump");
		expect(typeof d?.__sync?.hash).toBe("string");

		await engine.stop();
	});

	test("carimba dumpCompletedAt e salva resumeToken ao concluir", async () => {
		await seed(srcDb, "colA", 20);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		const st = await loadSyncState(dstDb, "colA");
		expect(typeof st.dumpCompletedAt).toBe("number");

		await engine.stop();

		const st2 = await loadSyncState(dstDb, "colA");
		expect(st2.resumeToken).toBeDefined();
	});
});
