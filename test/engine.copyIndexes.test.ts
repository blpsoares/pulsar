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
	srcName = uniqueDbName("eci_src");
	dstName = uniqueDbName("eci_dst");
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

describe("SyncEngine — copyIndexes", () => {
	test("copyIndexes:true replica o índice da origem após o dump", async () => {
		await seed(srcDb, "colA", 10);
		await srcDb.collection("colA").createIndex({ v: 1 });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			copyIndexes: true,
			checkpointIntervalMs: 100,
		});
		await engine.start();

		const idx = (await dstDb.collection("colA").indexes()).find(
			(i) => i.key?.v === 1,
		);
		expect(idx).toBeDefined();
		expect(engine.indexesCreated).toBe(1);

		await engine.stop();
	});

	test("copyIndexes:true no path de RESUME: cria índice sem re-dumpar", async () => {
		await seed(srcDb, "colR", 10);

		// 1ª execução SEM copyIndexes — estabelece dumpCompletedAt + resume token
		const e1 = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colR" }],
			checkpointIntervalMs: 100,
		});
		await e1.start();
		await e1.stop();

		// Cria índice na origem APÓS o dump inicial
		await srcDb.collection("colR").createIndex({ v: 1 });

		// 2ª execução COM copyIndexes — deve RETOMAR (não re-dumpar) e copiar o índice
		const e2 = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colR" }],
			copyIndexes: true,
			checkpointIntervalMs: 100,
		});
		await e2.start();

		expect(e2.indexesCreated).toBeGreaterThanOrEqual(1);
		const idx = (await dstDb.collection("colR").indexes()).find(
			(i) => i.key?.v === 1,
		);
		expect(idx).toBeDefined();

		await e2.stop();
	});

	test("default (sem copyIndexes): NÃO replica índices", async () => {
		await seed(srcDb, "colA", 10);
		await srcDb.collection("colA").createIndex({ v: 1 });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		const idx = (await dstDb.collection("colA").indexes()).find(
			(i) => i.key?.v === 1,
		);
		expect(idx).toBeUndefined();
		expect(engine.indexesCreated).toBe(0);

		await engine.stop();
	});
});
