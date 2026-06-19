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
import { loadDbResumeToken } from "../src/core/sync/syncState";
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
	srcName = uniqueDbName("dbw_src");
	dstName = uniqueDbName("dbw_dst");
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

function makeEngine() {
	return new SyncEngine({
		sourceDb: srcDb,
		destDb: dstDb,
		collections: [{ name: "colA" }, { name: "colB" }],
		checkpointIntervalMs: 100,
	});
}

describe("SyncEngine — stream único (db.watch) com roteamento por ns.coll", () => {
	test("um stream sincroniza e roteia eventos ao vivo pras collections certas", async () => {
		await seed(srcDb, "colA", 30);
		await seed(srcDb, "colB", 30);

		const engine = makeEngine();
		await engine.start();

		expect(await dstDb.collection("colA").countDocuments()).toBe(30);
		expect(await dstDb.collection("colB").countDocuments()).toBe(30);

		// eventos ao vivo nas DUAS collections → cada um tem que cair na sua
		await srcDb.collection("colA").insertOne({ _id: 100 as any, v: "A_LIVE" });
		await srcDb.collection("colB").insertOne({ _id: 200 as any, v: "B_LIVE" });

		const routedA = await waitFor(
			async () =>
				(await dstDb.collection("colA").findOne({ _id: 100 as any }))?.v ===
				"A_LIVE",
		);
		const routedB = await waitFor(
			async () =>
				(await dstDb.collection("colB").findOne({ _id: 200 as any }))?.v ===
				"B_LIVE",
		);
		expect(routedA).toBe(true);
		expect(routedB).toBe(true);
		// nada vazou pra collection errada
		expect(
			await dstDb.collection("colA").findOne({ _id: 200 as any }),
		).toBeNull();

		await engine.stop();
		// token global do db.watch foi persistido
		expect(await loadDbResumeToken(dstDb)).toBeDefined();
	});

	test("restart retoma pelo token global e aplica mudanças offline das duas, sem re-dump", async () => {
		await seed(srcDb, "colA", 30);
		await seed(srcDb, "colB", 30);

		const e1 = makeEngine();
		await e1.start();
		await e1.stop();

		// corrompe um doc em cada (hash divergente) — só um dump consertaria
		for (const c of ["colA", "colB"]) {
			await dstDb
				.collection(c)
				.updateOne(
					{ _id: 10 as any },
					{ $set: { v: "CORROMPIDO", "__sync.hash": "BOGUS" } },
				);
		}
		// mudanças offline nas duas
		await srcDb
			.collection("colA")
			.updateOne({ _id: 5 as any }, { $set: { v: "A_OFF" } });
		await srcDb
			.collection("colB")
			.updateOne({ _id: 6 as any }, { $set: { v: "B_OFF" } });

		const e2 = makeEngine();
		await e2.start();

		const okA = await waitFor(
			async () =>
				(await dstDb.collection("colA").findOne({ _id: 5 as any }))?.v ===
				"A_OFF",
		);
		const okB = await waitFor(
			async () =>
				(await dstDb.collection("colB").findOne({ _id: 6 as any }))?.v ===
				"B_OFF",
		);
		expect(okA).toBe(true);
		expect(okB).toBe(true);

		// não re-dumpou: corrompidos seguem corrompidos
		expect(
			(await dstDb.collection("colA").findOne({ _id: 10 as any }))?.v,
		).toBe("CORROMPIDO");
		expect(
			(await dstDb.collection("colB").findOne({ _id: 10 as any }))?.v,
		).toBe("CORROMPIDO");

		await e2.stop();
	});
});
