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
	srcName = uniqueDbName("fb_src");
	dstName = uniqueDbName("fb_dst");
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
		collections: [{ name: "colA" }],
		checkpointIntervalMs: 100,
	});
}

describe("SyncEngine — fallback de resume impossível (286/token inválido)", () => {
	test("token inutilizável → re-dumpa a collection", async () => {
		await seed(srcDb, "colA", 20);

		const e1 = makeEngine();
		await e1.start();
		await e1.stop();

		// Corrompe um doc no destino com HASH divergente: só um DUMP (que compara
		// hash) o corrigiria — corromper só `v` não bastaria, o dump pularia.
		await dstDb
			.collection("colA")
			.updateOne(
				{ _id: 10 as any },
				{ $set: { v: "CORROMPIDO", "__sync.hash": "BOGUS" } },
			);

		// Substitui o token GLOBAL (do db.watch) por um inválido → o resume do
		// stream único falha (286) → forceDumpAll → re-dumpa tudo.
		await dstDb.collection("__sync").updateOne(
			{ id: "__pulsar_db__" },
			{
				$set: {
					resumeToken: {
						_data: "82FFFFFFFF0000000000000000000000000000000000000000000000",
					},
				},
			},
		);

		const e2 = makeEngine();
		await e2.start();

		// O fallback dumpou: doc corrompido volta ao valor da origem (v=10).
		const fixed = await waitFor(async () => {
			const d = await dstDb.collection("colA").findOne({ _id: 10 as any });
			return d?.v === 10;
		});
		expect(fixed).toBe(true);

		// Carimbo de conclusão foi re-setado após o dump do fallback.
		const st = await loadSyncState(dstDb, "colA");
		expect(typeof st.dumpCompletedAt).toBe("number");

		await e2.stop();
	});
});
