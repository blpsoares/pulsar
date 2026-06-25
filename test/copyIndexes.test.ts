// test/copyIndexes.test.ts
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { ensureCollectionIndexes } from "../src/core/sync/copyIndexes";
import { connect, DST_URI, dropDb, SRC_URI, uniqueDbName } from "./helpers";

let srcClient: MongoClient;
let dstClient: MongoClient;
let srcDb: Db;
let dstDb: Db;
let srcName: string;
let dstName: string;

beforeAll(async () => {
	srcClient = await connect(SRC_URI);
	dstClient = await connect(DST_URI);
	srcName = uniqueDbName("idx_src");
	dstName = uniqueDbName("idx_dst");
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

async function names(db: Db, coll: string): Promise<string[]> {
	const idx = await db.collection(coll).indexes();
	return idx.map((i) => i.name as string).sort();
}

describe("ensureCollectionIndexes", () => {
	test("destino vazio: cria todos os índices secundários da origem (menos _id_)", async () => {
		await srcDb.collection("c").createIndex({ email: 1 }, { unique: true });
		await srcDb.collection("c").createIndex({ age: -1 });
		await dstDb.collection("c").insertOne({ _id: 1 as any }); // materializa a coll
		await dstDb.collection("c").deleteMany({});

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(2);
		expect(res.skipped).toBe(0);
		expect(res.failed).toHaveLength(0);
		expect(await names(dstDb, "c")).toContain("email_1");
		expect(await names(dstDb, "c")).toContain("age_-1");
	});

	test("destino já com os mesmos índices: created=0, skipped=2, zero escrita", async () => {
		await srcDb.collection("c").createIndex({ email: 1 }, { unique: true });
		await srcDb.collection("c").createIndex({ age: -1 });
		await dstDb.collection("c").createIndex({ email: 1 }, { unique: true });
		await dstDb.collection("c").createIndex({ age: -1 });

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(0);
		expect(res.skipped).toBe(2);
	});

	test("índice equivalente com nome diferente no destino: pula (não duplica)", async () => {
		await srcDb
			.collection("c")
			.createIndex({ status: 1 }, { name: "src_status" });
		await dstDb
			.collection("c")
			.createIndex({ status: 1 }, { name: "dst_status" });

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(0);
		expect(res.skipped).toBe(1);
		// não criou um segundo índice equivalente
		expect(
			(await dstDb.collection("c").indexes()).filter(
				(i) => i.key?.status === 1,
			),
		).toHaveLength(1);
	});

	test("conflito de nome (mesmo nome, spec diferente): entra em failed, não lança", async () => {
		await srcDb.collection("c").createIndex({ a: 1 }, { name: "dup" });
		await dstDb.collection("c").createIndex({ b: 1 }, { name: "dup" });

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(0);
		expect(res.failed).toHaveLength(1);
		expect(res.failed[0]?.name).toBe("dup");
	});

	test("índice TTL (expireAfterSeconds) é replicado fiel", async () => {
		await srcDb
			.collection("c")
			.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
		await dstDb.collection("c").insertOne({ _id: 1 as any });

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(1);
		const idx = (await dstDb.collection("c").indexes()).find(
			(i) => i.key?.createdAt === 1,
		);
		expect(idx?.expireAfterSeconds).toBe(3600);
	});

	test("só _id_ na origem: no-op", async () => {
		await srcDb.collection("c").insertOne({ _id: 1 as any });
		await dstDb.collection("c").insertOne({ _id: 1 as any });

		const res = await ensureCollectionIndexes(
			srcDb.collection("c"),
			dstDb.collection("c"),
		);

		expect(res.created).toBe(0);
		expect(res.skipped).toBe(0);
	});
});
