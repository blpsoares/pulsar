import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { applyTtl } from "../src/core/ttl/applyTtl";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("apply");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

async function ttlIndex(db: Db, coll: string, field: string) {
	const idx = await db.collection(coll).indexes();
	return idx.find(
		(i) => i.key?.[field] === 1 && i.expireAfterSeconds !== undefined,
	);
}

describe("applyTtl", () => {
	test("deriveFromId: materializa _created e cria índice TTL nele", async () => {
		await db.collection("a").insertOne({ _id: new ObjectId(), x: 1 });
		const out = await applyTtl(db, {
			name: "a",
			field: "_created",
			deriveFromId: true,
			expireAfterSeconds: 2592000,
		});
		expect(out.derivedCount).toBe(1);
		const idx = await ttlIndex(db, "a", "_created");
		expect(idx?.expireAfterSeconds).toBe(2592000);
	});

	test("campo Date existente: cria índice TTL sem materializar", async () => {
		await db.collection("b").insertOne({ ts: new Date("2020-01-01"), x: 1 });
		const out = await applyTtl(db, {
			name: "b",
			field: "ts",
			deriveFromId: false,
			expireAfterSeconds: 3600,
		});
		expect(out.derivedCount).toBeUndefined();
		const idx = await ttlIndex(db, "b", "ts");
		expect(idx?.expireAfterSeconds).toBe(3600);
	});
});
