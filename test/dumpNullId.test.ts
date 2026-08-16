import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { dumpCollections } from "../src/core/sync/dumpEvent";
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
	srcName = uniqueDbName("nid_src");
	dstName = uniqueDbName("nid_dst");
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
	process.env.DUMP_MAX_RETRIES = "3"; // falha rápido se o laço voltar
});

/**
 * Insere preservando `_id: null`. O driver Node SUBSTITUI um `_id: null`
 * explícito por um ObjectId gerado no insertOne/insertMany (ele trata null como
 * "não informado"), então só o comando cru cria o doc que existe de verdade em
 * produção.
 */
const insertRaw = (db: Db, coll: string, documents: unknown[]) =>
	db.command({ insert: coll, documents });

describe("dump com _id null (legítimo no Mongo)", () => {
	// Formato real da collection `skus` da produção: 1 doc com _id null entre
	// milhares de _id int. O `_id == null continue` descartava esse doc, a
	// fronteira nunca passava dele, e o dump falhava em TODO restart.
	test("copia o doc de _id null e CONCLUI (antes: laço infinito → falha)", async () => {
		await insertRaw(srcDb, "skus", [
			...Array.from({ length: 50 }, (_, i) => ({ _id: i + 1, v: i })),
			{ _id: null, v: "nulo" },
		]);

		const ok = await dumpCollections(
			srcDb.collection("skus"),
			dstDb.collection("skus"),
			new Set(),
			{ batchSize: 10 },
		);

		expect(ok).toBe(true);
		expect(await dstDb.collection("skus").countDocuments()).toBe(51);
		const nulo = await dstDb.collection("skus").findOne({ _id: null as never });
		expect(nulo?.v).toBe("nulo");
	});

	test("_id null é a fronteira final e não reinicia a varredura", async () => {
		await insertRaw(srcDb, "skus", [
			{ _id: null, v: "nulo" },
			{ _id: 1, v: "um" },
			{ _id: 2, v: "dois" },
		]);

		const fronteiras: unknown[] = [];
		const ok = await dumpCollections(
			srcDb.collection("skus"),
			dstDb.collection("skus"),
			new Set(),
			{ batchSize: 1, onProgress: (id) => fronteiras.push(id) },
		);

		expect(ok).toBe(true);
		expect(await dstDb.collection("skus").countDocuments()).toBe(3);
		// null é o MENOR na ordem BSON → última fronteira. Se `null` fosse lido
		// como "sem fronteira", a varredura recomeçaria do topo.
		expect(fronteiras[fronteiras.length - 1]).toBeNull();
	});

	test("_id 0 e string vazia continuam funcionando", async () => {
		await insertRaw(srcDb, "c", [
			{ _id: 0, v: "zero" },
			{ _id: "", v: "vazio" },
			{ _id: 5, v: "cinco" },
		]);

		const ok = await dumpCollections(
			srcDb.collection("c"),
			dstDb.collection("c"),
			new Set(),
			{ batchSize: 2 },
		);

		expect(ok).toBe(true);
		expect(await dstDb.collection("c").countDocuments()).toBe(3);
	});

	test("retomada a partir de uma fronteira null não re-varre tudo", async () => {
		await insertRaw(srcDb, "c", [
			{ _id: null, v: "nulo" },
			{ _id: 1, v: "um" },
		]);

		// fronteira = null significa "já processei até o menor de todos" → nada
		// abaixo, dump encerra sem copiar nada.
		const ok = await dumpCollections(
			srcDb.collection("c"),
			dstDb.collection("c"),
			new Set(),
			{ resumeFromId: null },
		);

		expect(ok).toBe(true);
		expect(await dstDb.collection("c").countDocuments()).toBe(0);
	});
});
