// test/engine.refetch.test.ts
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, Db, MongoClient } from "mongodb";
import { dumpCollections } from "../src/core/sync/dumpEvent";
import { SyncEngine } from "../src/core/sync/engine";
import { setLogConfig } from "../src/utils/logConfig";
import {
	connect,
	DST_URI,
	dropDb,
	SRC_URI,
	seed,
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
	srcName = uniqueDbName("refetch_src");
	dstName = uniqueDbName("refetch_dst");
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

function mkEngine() {
	return new SyncEngine({
		sourceDb: srcDb,
		destDb: dstDb,
		collections: [{ name: "c" }],
		checkpointIntervalMs: 100,
		flushIntervalMs: 150,
	});
}

describe("dumpCollections — proteção da race delete-durante-dump (I1)", () => {
	test("deletedIds passado ao dumpCollections impede ressurreição de doc deletado", async () => {
		// Semeia 3 docs na origem (_id 0, 1, 2)
		await srcDb.collection("c").insertMany([
			{ _id: 0 as any, v: "zero" },
			{ _id: 1 as any, v: "um" },
			{ _id: 2 as any, v: "dois" },
		]);

		// Simula que _id "1" foi deletado na origem ENQUANTO o dump rodava:
		// o engine já aplicou o deleteOne no destino e registrou "1" em deletedIds.
		// O dump não deve ressuscitar esse doc ao processar o lote da origem.
		await dumpCollections(
			srcDb.collection("c"),
			dstDb.collection("c"),
			["1"], // deletedIds: "1" foi deletado durante o dump
			{},
		);

		const ids = await dstDb
			.collection("c")
			.find({}, { projection: { _id: 1 } })
			.map((d) => d._id)
			.toArray();
		const idSet = new Set(ids.map(Number));

		expect(idSet.has(0)).toBe(true); // _id:0 deve existir
		expect(idSet.has(2)).toBe(true); // _id:2 deve existir
		expect(idSet.has(1)).toBe(false); // _id:1 foi "deletado durante dump" — não ressuscita
	});
});

describe("SyncEngine — watch por re-busca", () => {
	test("insert/update ao vivo são replicados (via re-busca), com __migratedAt", async () => {
		await seed(srcDb, "c", 1); // _id:0
		const engine = mkEngine();
		await engine.start();

		await srcDb.collection("c").insertOne({ _id: 5 as any, v: "novo" });
		await srcDb
			.collection("c")
			.updateOne({ _id: 0 as any }, { $set: { v: "alterado" } });

		const ok = await waitFor(async () => {
			const a = await dstDb.collection("c").findOne({ _id: 5 as any });
			const b = await dstDb.collection("c").findOne({ _id: 0 as any });
			return a?.v === "novo" && b?.v === "alterado";
		}, 8000);
		expect(ok).toBe(true);
		const novo = await dstDb.collection("c").findOne({ _id: 5 as any });
		expect(novo?.__migratedAt).toBeInstanceOf(Date);

		await engine.stop();
	});

	test("delete ao vivo propaga", async () => {
		await seed(srcDb, "c", 2); // _id 0,1
		const engine = mkEngine();
		await engine.start();
		await waitFor(
			async () => (await dstDb.collection("c").countDocuments()) === 2,
			8000,
		);

		await srcDb.collection("c").deleteOne({ _id: 1 as any });
		const gone = await waitFor(
			async () =>
				(await dstDb.collection("c").findOne({ _id: 1 as any })) === null,
			8000,
		);
		expect(gone).toBe(true);
		await engine.stop();
	});

	test("documento grande NÃO quebra o stream (sem erro 16MB) e chega no destino", async () => {
		await seed(srcDb, "c", 1);
		const engine = mkEngine();
		await engine.start();

		// ~12MB de string num doc; um update grande NÃO pode derrubar o watch
		const big = "x".repeat(12 * 1024 * 1024);
		await srcDb.collection("c").insertOne({ _id: 9 as any, big });

		const arrived = await waitFor(async () => {
			const d = await dstDb
				.collection("c")
				.findOne({ _id: 9 as any }, { projection: { _id: 1 } });
			return d !== null;
		}, 15000);
		expect(arrived).toBe(true);
		await engine.stop();
	});

	test("falha transitória no flush re-enfileira o evento e não perde o dado", async () => {
		await seed(srcDb, "c", 1); // _id:0 já existente
		const engine = mkEngine();
		await engine.start();

		// Aguarda o dump inicial concluir (o doc _id:0 deve estar no destino).
		await waitFor(
			async () => (await dstDb.collection("c").countDocuments()) === 1,
			8000,
		);

		// Acessa a rota interna da engine e faz updateOne lançar uma vez (falha transitória).
		const route = (engine as any).routes.get("c") as {
			destCol: Collection;
		};
		const origUpdateOne = route.destCol.updateOne.bind(route.destCol);
		let failsLeft = 1;
		(route.destCol as any).updateOne = async (
			...args: Parameters<typeof origUpdateOne>
		) => {
			if (failsLeft-- > 0) throw new Error("transient ECONNRESET");
			return origUpdateOne(...args);
		};

		// Dispara uma inserção que vai enfileirar no buffer.
		await srcDb.collection("c").insertOne({ _id: 42 as any, v: "re-enqueue" });

		// Aguarda 1 ciclo de flush (flushIntervalMs=150ms) para a falha acontecer.
		await sleep(350);

		// Remove o patch — o próximo flush deve re-tentar e aplicar com sucesso.
		(route.destCol as any).updateOne = origUpdateOne;

		// O dado deve chegar ao destino (re-enqueue funcionou).
		const arrived = await waitFor(async () => {
			const d = await dstDb.collection("c").findOne({ _id: 42 as any });
			return d?.v === "re-enqueue";
		}, 8000);
		expect(arrived).toBe(true);

		await engine.stop();
	});
});
