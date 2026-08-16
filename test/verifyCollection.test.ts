import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { verifyCollection } from "../src/core/verify/verifyCollection";
import { setLogConfig } from "../src/utils/logConfig";
import { connect, DST_URI, dropDb, SRC_URI, uniqueDbName } from "./helpers";

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
	srcName = uniqueDbName("ver_src");
	dstName = uniqueDbName("ver_dst");
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

describe("verifyCollection", () => {
	test("modo count reporta o déficit sem varrer _ids", async () => {
		await srcDb
			.collection("c")
			.insertMany(Array.from({ length: 30 }, (_, i) => ({ _id: i as never })));
		await dstDb
			.collection("c")
			.insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: i as never })));

		const r = await verifyCollection(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(r.sourceCount).toBe(30);
		expect(r.destCount).toBe(10);
		expect(r.missing).toBe(-1); // count não investiga _ids
		expect(r.mode).toBe("count");
	});

	test("modo deep encontra QUAIS _ids faltam", async () => {
		await srcDb
			.collection("c")
			.insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: i as never })));
		await dstDb
			.collection("c")
			.insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: i as never })));
		await dstDb
			.collection("c")
			.deleteMany({ _id: { $in: [3, 7, 11] as never[] } });

		const r = await verifyCollection(
			srcDb.collection("c"),
			dstDb.collection("c"),
			{ mode: "deep", batchSize: 5 },
		);

		expect(r.missing).toBe(3);
		expect(
			[...r.missingSample].sort((a, b) => (a as number) - (b as number)),
		).toEqual([3, 7, 11]);
	});

	// O cenário que quebrou em produção: _id composto.
	test("deep funciona com _id COMPOSTO (onde String(_id) colidia)", async () => {
		const docs = Array.from({ length: 40 }, (_, i) => ({
			_id: { chave: `k${i}`, target: "t1" } as never,
			v: i,
		}));
		await srcDb.collection("comp").insertMany(docs);
		// destino recebeu só os 10 primeiros — exatamente o formato da perda real
		await dstDb.collection("comp").insertMany(docs.slice(0, 10));

		const r = await verifyCollection(
			srcDb.collection("comp"),
			dstDb.collection("comp"),
			{ mode: "deep", batchSize: 7 },
		);

		// Com String(_id) tudo casaria com "[object Object]" e missing daria 0.
		expect(r.missing).toBe(30);
		expect(r.sourceCount).toBe(40);
		expect(r.destCount).toBe(10);
	});

	test("reconcile recopia os docs faltantes de verdade", async () => {
		const docs = Array.from({ length: 25 }, (_, i) => ({
			_id: { chave: `k${i}` } as never,
			v: i,
		}));
		await srcDb.collection("comp").insertMany(docs);
		await dstDb.collection("comp").insertMany(docs.slice(0, 5));

		const r = await verifyCollection(
			srcDb.collection("comp"),
			dstDb.collection("comp"),
			{ mode: "deep", batchSize: 10, reconcile: true },
		);

		expect(r.missing).toBe(20);
		expect(r.reconciled).toBe(20);
		expect(await dstDb.collection("comp").countDocuments()).toBe(25);

		// e uma segunda passada não acha mais nada
		const again = await verifyCollection(
			srcDb.collection("comp"),
			dstDb.collection("comp"),
			{ mode: "deep" },
		);
		expect(again.missing).toBe(0);
	});

	test("respeita o filtro da collection", async () => {
		await srcDb.collection("c").insertMany([
			{ _id: 1 as never, status: "active" },
			{ _id: 2 as never, status: "active" },
			{ _id: 3 as never, status: "off" },
		]);
		await dstDb
			.collection("c")
			.insertMany([{ _id: 1 as never, status: "active" }]);

		const r = await verifyCollection(
			srcDb.collection("c"),
			dstDb.collection("c"),
			{ mode: "deep", filter: { status: "active" } },
		);

		expect(r.sourceCount).toBe(2); // só os "active"
		expect(r.missing).toBe(1); // o _id 2
		expect(r.missingSample).toEqual([2]);
	});

	test("collection ausente na origem vira erro contido, não exceção", async () => {
		const r = await verifyCollection(
			srcDb.collection("naoexiste"),
			dstDb.collection("naoexiste"),
			{ mode: "deep" },
		);
		expect(r.error).toBeUndefined(); // coll vazia é válida
		expect(r.sourceCount).toBe(0);
		expect(r.missing).toBe(0);
	});
});
