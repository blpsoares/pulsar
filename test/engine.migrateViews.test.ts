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
	srcName = uniqueDbName("emv_src");
	dstName = uniqueDbName("emv_dst");
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

async function isView(db: Db, name: string): Promise<boolean> {
	const info = (await db.listCollections({ name }).toArray())[0];
	return info?.type === "view";
}

describe("SyncEngine — migrateViews (paralelo ao dump)", () => {
	test("migrateViews:true recria as views da origem no destino", async () => {
		await seed(srcDb, "colA", 10);
		await srcDb.createCollection("colA_view", {
			viewOn: "colA",
			pipeline: [{ $match: { v: { $gte: 5 } } }],
		});

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			migrateViews: true,
			checkpointIntervalMs: 100,
		});
		await engine.start();

		expect(engine.viewsCreated).toBe(1);
		expect(await isView(dstDb, "colA_view")).toBe(true);
		// a view resolve sobre os dados sincronizados (5..9 = 5 docs)
		expect(await dstDb.collection("colA_view").countDocuments()).toBe(5);

		await engine.stop();
	});

	test("migrateViews por array: só as nomeadas", async () => {
		await seed(srcDb, "colA", 3);
		await srcDb.createCollection("v_sim", { viewOn: "colA", pipeline: [] });
		await srcDb.createCollection("v_nao", { viewOn: "colA", pipeline: [] });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			migrateViews: ["v_sim"],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		expect(await isView(dstDb, "v_sim")).toBe(true);
		expect(await isView(dstDb, "v_nao")).toBe(false);

		await engine.stop();
	});

	test("default (sem migrateViews): NÃO cria views", async () => {
		await seed(srcDb, "colA", 3);
		await srcDb.createCollection("v1", { viewOn: "colA", pipeline: [] });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		expect(engine.viewsCreated).toBe(0);
		expect(await isView(dstDb, "v1")).toBe(false);

		await engine.stop();
	});
});
