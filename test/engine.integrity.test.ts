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
	srcName = uniqueDbName("int_src");
	dstName = uniqueDbName("int_dst");
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

const mkEngine = (
	opts: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {},
) =>
	new SyncEngine({
		sourceDb: srcDb,
		destDb: dstDb,
		collections: [{ name: "colA" }],
		batchSize: 100,
		checkpointIntervalMs: 100,
		...opts,
	});

/**
 * Reproduz o estado real do usuário: um run legítimo carimba `dumpCompletedAt`
 * e grava um resume token VÁLIDO; depois o destino perde documentos (foi o que o
 * dump truncado fez, sem ninguém notar). No próximo start, a collection jura que
 * está em dia.
 */
async function runLegitimoDepoisFura(remover: number) {
	const first = mkEngine();
	await first.start();
	await first.stop();
	if (remover > 0) {
		const ids = await dstDb
			.collection("colA")
			.find({}, { projection: { _id: 1 } })
			.limit(remover)
			.toArray();
		await dstDb
			.collection("colA")
			.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
	}
}

describe("SyncEngine — checagem de integridade no startup", () => {
	test("collection que se diz em dia mas está CURTA é re-dumpada (não retomada)", async () => {
		await seed(srcDb, "colA", 500);
		await runLegitimoDepoisFura(380); // destino fica com 120 de 500

		expect(await dstDb.collection("colA").countDocuments()).toBe(120);

		const engine = mkEngine();
		await engine.start();

		expect(engine.integrityDeficits).toHaveLength(1);
		expect(engine.integrityDeficits[0]).toMatchObject({
			coll: "colA",
			source: 500,
			dest: 120,
		});
		// o buraco fechou — era isto que o restart NÃO fazia
		expect(await dstDb.collection("colA").countDocuments()).toBe(500);

		await engine.stop();
	}, 60000);

	test("collection realmente em dia RETOMA — sem re-dump desnecessário", async () => {
		await seed(srcDb, "colA", 200);
		await runLegitimoDepoisFura(0);

		const engine = mkEngine();
		await engine.start();

		expect(engine.integrityDeficits).toHaveLength(0);
		expect(engine.dumpsPlanned).toBe(0);
		expect(engine.resumedCount).toBe(1);

		await engine.stop();
	}, 60000);

	test("destino com MAIS docs que a origem não dispara re-dump (órfão não é déficit)", async () => {
		await seed(srcDb, "colA", 50);
		await runLegitimoDepoisFura(0);
		// órfãos: docs que não existem mais na origem (ex.: drop/recriação lá)
		await dstDb
			.collection("colA")
			.insertMany(
				Array.from({ length: 30 }, (_, i) => ({ _id: (900 + i) as never })),
			);

		const engine = mkEngine();
		await engine.start();

		expect(engine.integrityDeficits).toHaveLength(0);
		expect(engine.dumpsPlanned).toBe(0);

		await engine.stop();
	}, 60000);

	test("integrityCheck:false preserva o comportamento antigo (confia no carimbo)", async () => {
		await seed(srcDb, "colA", 500);
		await runLegitimoDepoisFura(380);

		const engine = mkEngine({ integrityCheck: false });
		await engine.start();

		expect(engine.integrityDeficits).toHaveLength(0);
		expect(engine.resumedCount).toBe(1);
		expect(engine.dumpsPlanned).toBe(0);
		// segue curto: é exatamente o "52/52 up to date" com dado faltando
		expect(await dstDb.collection("colA").countDocuments()).toBe(120);

		await engine.stop();
	}, 60000);

	test("respeita o filtro da collection ao comparar", async () => {
		await srcDb.collection("colA").insertMany([
			{ _id: 1 as never, status: "active" },
			{ _id: 2 as never, status: "active" },
			{ _id: 3 as never, status: "off" },
			{ _id: 4 as never, status: "off" },
		]);
		const filtered = { name: "colA", filter: { status: "active" } };
		const first = mkEngine({ collections: [filtered] });
		await first.start();
		await first.stop();

		// destino tem os 2 "active" e está em dia PARA O FILTRO, apesar de a origem
		// ter 4 docs no total. Comparar ignorando o filtro acusaria déficit falso.
		expect(await dstDb.collection("colA").countDocuments()).toBe(2);

		const engine = mkEngine({ collections: [filtered] });
		await engine.start();

		expect(engine.integrityDeficits).toHaveLength(0);
		expect(engine.dumpsPlanned).toBe(0);

		await engine.stop();
	}, 60000);
});
