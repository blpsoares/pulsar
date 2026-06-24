import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, type MongoClient, ObjectId } from "mongodb";
import { deriveCreated } from "../src/core/ttl/deriveCreated";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(DST_URI);
	dbName = uniqueDbName("derive");
	db = client.db(dbName);
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("deriveCreated", () => {
	test("materializa _created = timestamp do _id, e é idempotente", async () => {
		const oid = new ObjectId("58c8e3a0000000000000000a"); // 2017
		await db.collection("c1").insertOne({ _id: oid, nome: "x" });

		const modified = await deriveCreated(db, "c1");
		expect(modified).toBe(1);

		const doc = await db.collection("c1").findOne({ _id: oid });
		expect(doc?._created).toBeInstanceOf(Date);
		expect((doc?._created as Date).getTime()).toBe(oid.getTimestamp().getTime());

		// rodar de novo não modifica (filtro $exists:false)
		const again = await deriveCreated(db, "c1");
		expect(again).toBe(0);
	});

	test("aceita nome de campo customizado", async () => {
		await db.collection("c2").insertOne({ _id: new ObjectId(), nome: "y" });
		const modified = await deriveCreated(db, "c2", "_meuCampo");
		expect(modified).toBe(1);
		const doc = await db.collection("c2").findOne({ nome: "y" });
		expect(doc?._meuCampo).toBeInstanceOf(Date);
	});
});
