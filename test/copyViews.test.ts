import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import {
	copyViews,
	ensureView,
	listSourceViews,
} from "../src/core/sync/copyViews";
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
	srcName = uniqueDbName("cv_src");
	dstName = uniqueDbName("cv_dst");
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

/** Lê a definição (viewOn+pipeline) de uma view direto do catálogo. */
async function viewDef(db: Db, name: string) {
	const info = (
		await db.listCollections({ name }, { nameOnly: false }).toArray()
	)[0];
	return info
		? {
				type: info.type,
				viewOn: info.options?.viewOn,
				pipeline: info.options?.pipeline,
			}
		: null;
}

describe("copyViews — migração de views (metadados, sem sync)", () => {
	test("cria no destino uma view que só existe na origem", async () => {
		await srcDb.createCollection("v1", {
			viewOn: "base",
			pipeline: [{ $match: { ativo: true } }],
		});

		const r = await copyViews(srcDb, dstDb);

		expect(r.created).toBe(1);
		expect(r.createdNames).toContain("v1");
		const d = await viewDef(dstDb, "v1");
		expect(d?.type).toBe("view");
		expect(d?.viewOn).toBe("base");
		expect(d?.pipeline).toEqual([{ $match: { ativo: true } }]);
	});

	test("idempotente: rodar de novo não recria (skipped)", async () => {
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });
		await copyViews(srcDb, dstDb);

		const r2 = await copyViews(srcDb, dstDb);
		expect(r2.created).toBe(0);
		expect(r2.skipped).toBe(1);
	});

	test("pipeline diferente → drop+recreate deixa idêntica à origem", async () => {
		await srcDb.createCollection("v1", {
			viewOn: "base",
			pipeline: [{ $match: { a: 1 } }],
		});
		await copyViews(srcDb, dstDb);

		// origem muda o pipeline
		await srcDb.command({
			collMod: "v1",
			viewOn: "base",
			pipeline: [{ $match: { a: 2 } }],
		});

		const r = await copyViews(srcDb, dstDb);
		expect(r.updated).toBe(1);
		const d = await viewDef(dstDb, "v1");
		expect(d?.pipeline).toEqual([{ $match: { a: 2 } }]);
	});

	test("filtro por nomes: migra só as listadas", async () => {
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });
		await srcDb.createCollection("v2", { viewOn: "base", pipeline: [] });

		const r = await copyViews(srcDb, dstDb, ["v1"]);
		expect(r.created).toBe(1);
		expect(await viewDef(dstDb, "v1")).not.toBeNull();
		expect(await viewDef(dstDb, "v2")).toBeNull();
	});

	test("SEGURANÇA: destino com COLLECTION de mesmo nome não é destruída", async () => {
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });
		// destino tem uma collection REAL chamada v1 (com dado)
		await dstDb.collection("v1").insertOne({ _id: 1 as never, x: 1 });

		const r = await copyViews(srcDb, dstDb);
		expect(r.failed).toHaveLength(1);
		expect(r.failed[0].name).toBe("v1");
		// a collection real continua intacta
		const d = await viewDef(dstDb, "v1");
		expect(d?.type).toBe("collection");
		expect(await dstDb.collection("v1").countDocuments()).toBe(1);
	});

	test("nunca remove view que só existe no destino", async () => {
		await dstDb.createCollection("orfa", { viewOn: "base", pipeline: [] });
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });

		await copyViews(srcDb, dstDb);
		expect(await viewDef(dstDb, "orfa")).not.toBeNull();
	});

	test("listSourceViews respeita o filtro de nomes", async () => {
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });
		await srcDb.createCollection("v2", { viewOn: "base", pipeline: [] });
		const all = await listSourceViews(srcDb);
		const one = await listSourceViews(srcDb, ["v2"]);
		expect(all.map((v) => v.name).sort()).toEqual(["v1", "v2"]);
		expect(one.map((v) => v.name)).toEqual(["v2"]);
	});

	test("ensureView retorna 'created' e depois 'skipped'", async () => {
		await srcDb.createCollection("v1", { viewOn: "base", pipeline: [] });
		const [def] = await listSourceViews(srcDb);
		expect(await ensureView(dstDb, def)).toBe("created");
		expect(await ensureView(dstDb, def)).toBe("skipped");
	});
});
