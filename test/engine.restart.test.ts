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
	srcName = uniqueDbName("restart_src");
	dstName = uniqueDbName("restart_dst");
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

describe("SyncEngine — restart incremental", () => {
	test("retoma pelo token: aplica update/insert/delete offline SEM re-escanear", async () => {
		await seed(srcDb, "colA", 30); // _id 0..29

		// 1ª run: dump completo
		const e1 = makeEngine();
		await e1.start();
		expect(await dstDb.collection("colA").countDocuments()).toBe(30);
		await e1.stop();

		// Corrompe um doc no destino com HASH divergente (não sofrerá mudança
		// offline). Um dump compararia hash, veria a divergência e o corrigiria.
		// Se retomar (sem dump), ninguém o lê → fica corrompido. Prova de "não
		// escaneou". (Corromper só `v` não serviria: o dump pularia por hash.)
		await dstDb
			.collection("colA")
			.updateOne(
				{ _id: 10 as any },
				{ $set: { v: "CORROMPIDO", "__sync.hash": "BOGUS" } },
			);

		// Mudanças OFFLINE na origem (pulsar desligado)
		await srcDb
			.collection("colA")
			.updateOne({ _id: 5 as any }, { $set: { v: "OFFLINE_UPD" } });
		await srcDb
			.collection("colA")
			.insertOne({ _id: 100 as any, v: "OFFLINE_INS" });
		await srcDb.collection("colA").deleteOne({ _id: 7 as any });

		// 2ª run: deve RETOMAR (tem dumpCompletedAt + token)
		const e2 = makeEngine();
		await e2.start();

		// update offline aplicado
		const upd = await waitFor(async () => {
			const d = await dstDb.collection("colA").findOne({ _id: 5 as any });
			return d?.v === "OFFLINE_UPD";
		});
		expect(upd).toBe(true);

		// insert offline aplicado
		const ins = await waitFor(async () => {
			const d = await dstDb.collection("colA").findOne({ _id: 100 as any });
			return d?.v === "OFFLINE_INS";
		});
		expect(ins).toBe(true);

		// delete offline propagado (melhoria sobre a limitação atual do re-dump)
		const del = await waitFor(async () => {
			const d = await dstDb.collection("colA").findOne({ _id: 7 as any });
			return d === null;
		});
		expect(del).toBe(true);

		// prova de NÃO ter escaneado: doc corrompido continua corrompido
		const corrupt = await dstDb.collection("colA").findOne({ _id: 10 as any });
		expect(corrupt?.v).toBe("CORROMPIDO");

		await e2.stop();
	});
});
