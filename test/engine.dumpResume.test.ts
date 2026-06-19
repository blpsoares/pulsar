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
	srcName = uniqueDbName("dres_src");
	dstName = uniqueDbName("dres_dst");
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

describe("SyncEngine — dump interrompido retoma da fronteira", () => {
	test("continua de _id<fronteira e NÃO re-escaneia a parte já feita", async () => {
		await seed(srcDb, "colA", 100); // origem _id 0..99

		// Simula um dump interrompido na fronteira 50 (cursor varre _id:-1, então
		// já tinha processado a parte ALTA: _id 50..99 já estão no destino).
		await seed(dstDb, "colA", 0); // garante a collection
		const high = Array.from({ length: 50 }, (_, k) => ({
			_id: (50 + k) as any,
			v: 50 + k,
		}));
		await dstDb.collection("colA").insertMany(high);
		// Corrompe um doc da parte ALTA com hash divergente: se o restart
		// re-escaneasse a parte alta, ele consertaria. Se só varrer _id<50, fica.
		await dstDb
			.collection("colA")
			.updateOne(
				{ _id: 80 as any },
				{ $set: { v: "CORROMPIDO", "__sync.hash": "BOGUS" } },
			);
		// Estado de dump incompleto: fronteira salva, SEM carimbo de conclusão.
		await dstDb
			.collection("__sync")
			.insertOne({ id: "colA", dumpCursorId: 50 });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "colA" }],
			checkpointIntervalMs: 100,
		});
		await engine.start();

		// A parte que faltava (0..49) foi preenchida → 100 docs no total.
		expect(await dstDb.collection("colA").countDocuments()).toBe(100);
		expect(
			await dstDb.collection("colA").findOne({ _id: 0 as any }),
		).not.toBeNull();
		expect(
			await dstDb.collection("colA").findOne({ _id: 49 as any }),
		).not.toBeNull();

		// Prova de NÃO ter re-escaneado a parte alta: o doc corrompido continua.
		const corrupt = await dstDb.collection("colA").findOne({ _id: 80 as any });
		expect(corrupt?.v).toBe("CORROMPIDO");

		// Concluiu: carimbou e limpou a fronteira.
		const st = await loadSyncState(dstDb, "colA");
		expect(typeof st.dumpCompletedAt).toBe("number");
		expect(st.dumpCursorId).toBeUndefined();

		await engine.stop();
	});
});
