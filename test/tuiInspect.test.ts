import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { countExact, estimateMany } from "../src/core/inspect/collStats";
import { dbSummary } from "../src/core/inspect/dbStats";
import { indexSummaryMany } from "../src/core/inspect/indexSummary";
import { inspectDb } from "../src/core/inspect/inspectDb";
import { maskUri } from "../src/core/inspect/maskUri";
import { humanizeConnError, probeConnection } from "../src/core/inspect/probe";
import { connect, dropDb, SRC_URI, uniqueDbName } from "./helpers";

/**
 * Introspecção contra Mongo real — o mesmo padrão dos outros testes do projeto.
 * Precisa dos containers: `bun run test:up`.
 */

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
	client = await connect(SRC_URI);
	dbName = uniqueDbName("tui_inspect");
	db = client.db(dbName);

	await db.collection("users").insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
	await db.collection("orders").insertMany([{ v: 1 }]);
	await db.collection("users").createIndex({ n: 1 });
	await db.createCollection("v_users", {
		viewOn: "users",
		pipeline: [{ $match: { n: { $gt: 1 } } }],
	});
});

afterAll(async () => {
	await dropDb(client, dbName);
	await client.close();
});

describe("inspectDb", () => {
	test("separa collections de views e traz o viewOn", async () => {
		const { collections, views } = await inspectDb(db);

		expect(collections.map((c) => c.name)).toEqual(["orders", "users"]);
		expect(views).toHaveLength(1);
		expect(views[0]?.name).toBe("v_users");
		expect(views[0]?.viewOn).toBe("users");
	});

	test("não expõe a __sync nem collections de sistema", async () => {
		await db.collection("__sync").insertOne({ id: "x" });
		const { collections } = await inspectDb(db);
		expect(collections.map((c) => c.name)).not.toContain("__sync");
	});
});

describe("estimativas", () => {
	test("$collStats devolve contagem e tamanho sem varrer documentos", async () => {
		const estimates = await estimateMany(db, ["users", "orders"]);

		const users = estimates.find((e) => e.name === "users");
		expect(users?.docs).toBe(3);
		expect(users?.exact).toBe(false);
		expect(users?.storageSize).toBeGreaterThan(0);
		expect(users?.indexCount).toBeGreaterThanOrEqual(2); // _id_ + n_1
	});

	test("collection inexistente não derruba a coleta", async () => {
		const estimates = await estimateMany(db, ["users", "nao_existe"]);
		expect(estimates).toHaveLength(2);
		// $collStats numa collection ausente devolve vazio, não exceção
		expect(estimates.find((e) => e.name === "nao_existe")?.docs).toBe(0);
	});

	test("countExact respeita o filtro (a estimativa não)", async () => {
		expect(await countExact(db, "users")).toBe(3);
		expect(await countExact(db, "users", { n: { $gt: 1 } })).toBe(2);
	});

	test("resumo de índices conta só os secundários", async () => {
		const [orders, users] = await indexSummaryMany(db, ["users", "orders"]);
		expect(orders?.collection).toBe("orders");
		expect(orders?.secondaryCount).toBe(0); // só o _id_
		expect(users?.secondaryCount).toBe(1); // n_1
	});
});

describe("probe de conexão", () => {
	test("conecta e fecha sem vazar", async () => {
		const result = await probeConnection(SRC_URI);
		expect(result.ok).toBe(true);
		if (result.ok) await result.client.close();
	});

	test("URI inválida volta rápido com mensagem acionável", async () => {
		const result = await probeConnection("mongodb://127.0.0.1:1", 800);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	test("erro do driver vira frase acionável", () => {
		expect(
			humanizeConnError(new Error("bad auth : Authentication failed")),
		).toContain("usuário e senha");
		expect(humanizeConnError(new Error("connect ECONNREFUSED"))).toContain(
			"recusada",
		);
	});

	test("senha nunca aparece ao exibir a URI", () => {
		expect(maskUri("mongodb+srv://joao:s3nh4@cluster.net/db")).toBe(
			"mongodb+srv://joao:•••@cluster.net/db",
		);
		expect(maskUri("mongodb://localhost:27017")).toBe(
			"mongodb://localhost:27017",
		);
	});
});

describe("resumo do banco (dbStats)", () => {
	test("conta collections, views e índices numa chamada só", async () => {
		const summary = await dbSummary(db);

		expect(summary.error).toBeUndefined();
		// 2 collections criadas no beforeAll + a __sync do teste anterior
		expect(summary.collections).toBeGreaterThanOrEqual(2);
		expect(summary.views).toBe(1);
		// _id_ de cada collection + o índice n_1 criado no setup
		expect(summary.indexes).toBeGreaterThanOrEqual(3);
		expect(summary.objects).toBeGreaterThanOrEqual(4);
		expect(summary.storageSize).toBeGreaterThan(0);
	});

	test("banco inexistente responde zerado, sem lançar", async () => {
		const summary = await dbSummary(client.db("banco_que_nao_existe_pulsar"));
		expect(summary.error).toBeUndefined();
		expect(summary.collections).toBe(0);
		expect(summary.objects).toBe(0);
	});
});
