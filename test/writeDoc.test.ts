import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { writeDocToDest } from "../src/core/sync/writeDoc";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("writedoc");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

beforeEach(async () => {
	await db.dropDatabase();
});

describe("writeDocToDest", () => {
	test("1ª escrita grava o doc + __migratedAt como BSON Date", async () => {
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, v: 10 },
			"dump",
			false,
		);
		const d = await db.collection("c").findOne({ _id: 1 as any });
		expect(d?.v).toBe(10);
		expect(d?.__migratedAt).toBeInstanceOf(Date);
		expect(d?.__sync?.hash).toBeDefined();
	});

	test("2ª escrita PRESERVA o __migratedAt original (imutável)", async () => {
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, v: 10 },
			"dump",
			false,
		);
		const first = await db.collection("c").findOne({ _id: 1 as any });
		const firstAt = first?.__migratedAt as Date;
		await new Promise((r) => setTimeout(r, 15));
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, v: 99 },
			"watch:update",
			true,
		);
		const second = await db.collection("c").findOne({ _id: 1 as any });
		expect(second?.v).toBe(99); // doc atualizado
		expect((second?.__migratedAt as Date).getTime()).toBe(firstAt.getTime()); // data NÃO mudou
	});

	test("replace remove campo que sumiu da origem", async () => {
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, a: 1, b: 2 },
			"dump",
			false,
		);
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, a: 1 },
			"watch:replace",
			true,
		);
		const d = await db.collection("c").findOne({ _id: 1 as any });
		expect(d?.b).toBeUndefined(); // b removido (semântica de replace)
	});

	test("valor com '$' é gravado literal, não vira expressão", async () => {
		await writeDocToDest(
			db.collection("c"),
			{ _id: 1 as any, preco: "$5,00", op: "$inc" },
			"dump",
			false,
		);
		const d = await db.collection("c").findOne({ _id: 1 as any });
		expect(d?.preco).toBe("$5,00");
		expect(d?.op).toBe("$inc");
	});
});
