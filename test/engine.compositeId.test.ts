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
	sleep,
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
	srcName = uniqueDbName("cid_src");
	dstName = uniqueDbName("cid_dst");
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

/** `_id` no formato real da `_m_snapshotDados`: `{ chave, target }`. */
const cid = (i: number) => ({
	chave: `k${String(i).padStart(6, "0")}`,
	target: "t1",
});

describe("SyncEngine — _id COMPOSTO (regressão da perda silenciosa)", () => {
	test("delete ao vivo durante o dump NÃO pode zerar o resto do dump", async () => {
		const N = 4000;
		await srcDb
			.collection("snap")
			.insertMany(
				Array.from({ length: N }, (_, i) => ({ _id: cid(i) as never, v: i })),
			);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "snap" }],
			batchSize: 200,
			checkpointIntervalMs: 100,
			flushIntervalMs: 50,
		});

		const started = engine.start(); // não aguarda: dump em andamento

		// Deixa o change stream abrir e deleta UM doc na origem. Era exatamente
		// isto que envenenava `deletedIds` com "[object Object]" e fazia todo doc
		// de _id composto ser descartado do dump dali em diante.
		await sleep(80);
		await srcDb.collection("snap").deleteOne({ _id: cid(0) as never });

		await started;
		await sleep(400);

		const count = await dstDb.collection("snap").countDocuments();
		// N-1: só o doc realmente deletado pode faltar.
		expect(count).toBeGreaterThanOrEqual(N - 1);
		expect(
			await dstDb.collection("snap").findOne({ _id: cid(0) as never }),
		).toBeNull();
		// e um doc do "meio" (que o cursor alcançaria DEPOIS do delete) chegou
		expect(
			await dstDb.collection("snap").findOne({ _id: cid(2500) as never }),
		).not.toBeNull();

		await engine.stop();
	}, 60000);

	test("watch aplica MUITOS _ids compostos no mesmo flush (buffer não colapsa)", async () => {
		await srcDb.collection("snap").insertMany([{ _id: cid(0) as never, v: 0 }]);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "snap" }],
			batchSize: 500,
			flushIntervalMs: 50,
			checkpointIntervalMs: 100,
		});
		await engine.start();

		// 300 inserts numa janela de flush só. Com a chave String(id), os 300
		// colapsavam numa entrada e só 1 doc era gravado.
		await srcDb
			.collection("snap")
			.insertMany(
				Array.from({ length: 300 }, (_, i) => ({
					_id: cid(i + 1) as never,
					v: i,
				})),
			);

		const ok = await waitFor(
			async () => (await dstDb.collection("snap").countDocuments()) === 301,
			15000,
		);
		expect(ok).toBe(true);

		await engine.stop();
	}, 60000);

	test("update ao vivo de _id composto não apaga o doc do destino", async () => {
		await srcDb
			.collection("snap")
			.insertMany(
				Array.from({ length: 50 }, (_, i) => ({ _id: cid(i) as never, v: i })),
			);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "snap" }],
			flushIntervalMs: 50,
			checkpointIntervalMs: 100,
		});
		await engine.start();

		// Vários updates de _ids compostos DIFERENTES no mesmo lote. Com a colisão,
		// a comparação found/missing classificava docs vivos como ausentes e o
		// engine rodava deleteMany neles.
		for (let i = 0; i < 20; i++) {
			await srcDb
				.collection("snap")
				.updateOne({ _id: cid(i) as never }, { $set: { v: `LIVE_${i}` } });
		}

		const ok = await waitFor(async () => {
			const n = await dstDb.collection("snap").countDocuments();
			const d = await dstDb
				.collection("snap")
				.findOne({ _id: cid(19) as never });
			return n === 50 && d?.v === "LIVE_19";
		}, 15000);
		expect(ok).toBe(true);
		// nada foi apagado por engano
		expect(await dstDb.collection("snap").countDocuments()).toBe(50);

		await engine.stop();
	}, 60000);

	test("fronteira órfã (dumpCompletedAt + dumpCursorId) não certifica dump vazio", async () => {
		await srcDb
			.collection("snap")
			.insertMany(
				Array.from({ length: 100 }, (_, i) => ({ _id: i as never, v: i })),
			);
		// Estado corrompido pela corrida antiga: carimbo de concluído E fronteira
		// no MENOR _id. Sem token global, o startup escolhe dump e usaria essa
		// fronteira → varreria "abaixo de 0" (zero docs) e se certificaria de novo.
		await dstDb
			.collection("__sync")
			.insertOne({ id: "snap", dumpCompletedAt: Date.now(), dumpCursorId: 0 });

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "snap" }],
			batchSize: 50,
			checkpointIntervalMs: 100,
		});
		await engine.start();

		// a fronteira órfã foi ignorada e o dump copiou tudo
		expect(await dstDb.collection("snap").countDocuments()).toBe(100);
		const state = await loadSyncState(dstDb, "snap");
		expect(state.dumpCursorId).toBeUndefined();

		await engine.stop();
	}, 60000);
});
