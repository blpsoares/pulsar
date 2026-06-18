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
	waitFor,
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
	srcName = uniqueDbName("full_src");
	dstName = uniqueDbName("full_dst");
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

describe("SyncEngine — flag --full", () => {
	test("--full força dump mesmo com carimbo+token válidos", async () => {
		await seed(srcDb, "colA", 20);

		const e1 = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await e1.start();
		await e1.stop();

		// Corrompe com hash divergente: só um dump corrige.
		await dstDb
			.collection("colA")
			.updateOne(
				{ _id: 10 as any },
				{ $set: { v: "CORROMPIDO", "__sync.hash": "BOGUS" } },
			);

		const e2 = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			full: true,
			checkpointIntervalMs: 100,
		});
		await e2.start();

		const fixed = await waitFor(async () => {
			const d = await dstDb.collection("colA").findOne({ _id: 10 as any });
			return d?.v === 10;
		});
		expect(fixed).toBe(true);

		await e2.stop();
	});
});
