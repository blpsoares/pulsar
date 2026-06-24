import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { ttlCommand } from "../src/commands/ttl";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("ttlcmd");
	db = client.db(dbName);
	await db.collection("orders").insertOne({ _id: new ObjectId(), x: 1 });
	await db.collection("sessions").insertOne({ lastActivity: new Date("2020-01-01"), x: 1 });
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("ttlCommand (modo CLI)", () => {
	test("deriveFromId uniforme aplica TTL em várias collections", async () => {
		const out = await ttlCommand(undefined, {
			uri: DST_URI,
			db: dbName,
			collections: "orders",
			deriveFromId: true,
			expire: "30d",
		});
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe("orders");
		expect(out[0].expireAfterSeconds).toBe(2592000);

		const idx = (await db.collection("orders").indexes()).find(
			(i) => i.key?._created === 1 && i.expireAfterSeconds === 2592000,
		);
		expect(idx).toBeTruthy();
	});

	test("field explícito num campo Date existente", async () => {
		const out = await ttlCommand(undefined, {
			uri: DST_URI,
			db: dbName,
			collections: "sessions",
			field: "lastActivity",
			expire: "1h",
		});
		expect(out[0].expireAfterSeconds).toBe(3600);
	});

	test("erro: field e deriveFromId juntos no CLI", async () => {
		await expect(
			ttlCommand(undefined, {
				uri: DST_URI,
				db: dbName,
				collections: "orders",
				field: "ts",
				deriveFromId: true,
				expire: "1d",
			}),
		).rejects.toThrow();
	});

	test("erro: sem --expire no modo CLI", async () => {
		await expect(
			ttlCommand(undefined, {
				uri: DST_URI,
				db: dbName,
				collections: "orders",
				deriveFromId: true,
			}),
		).rejects.toThrow(/expire/i);
	});
});
