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
	srcName = uniqueDbName("vol_src");
	dstName = uniqueDbName("vol_dst");
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

describe("SyncEngine — volumetria, velocidade e paralelização", () => {
	test("restart (resume) é muito mais rápido que o dump cold, em 3 collections paralelas", async () => {
		const colls = [{ name: "c1" }, { name: "c2" }, { name: "c3" }];
		const N = 15000;
		for (const c of colls) await seed(srcDb, c.name, N);

		const mk = (full = false) =>
			new SyncEngine({
				sourceDb: srcDb,
				destDb: dstDb,
				collections: colls,
				parallel: 3,
				batchSize: 1000,
				full,
				checkpointIntervalMs: 100,
				resumeProbeMs: 300,
			});

		// COLD: dump das 3 collections
		const t0 = performance.now();
		const cold = mk();
		await cold.start();
		const coldMs = performance.now() - t0;
		// todos os docs migraram
		for (const c of colls)
			expect(await dstDb.collection(c.name).countDocuments()).toBe(N);
		await cold.stop();

		// RESTART: deve retomar (sem re-escanear)
		const t1 = performance.now();
		const warm = mk();
		await warm.start();
		const warmMs = performance.now() - t1;
		await warm.stop();

		// dado intacto
		for (const c of colls)
			expect(await dstDb.collection(c.name).countDocuments()).toBe(N);

		// o restart não escaneou 45k docs → tem que ser bem mais rápido
		console.log(
			`volumetria: cold=${Math.round(coldMs)}ms warm=${Math.round(warmMs)}ms ratio=${(warmMs / coldMs).toFixed(2)}`,
		);
		expect(warmMs).toBeLessThan(coldMs * 0.6);
	}, 60000);
});
