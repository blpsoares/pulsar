import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { ChangeBuffer } from "../src/core/sync/changeBuffer";
import { dumpCollections } from "../src/core/sync/dumpEvent";
import { idKey } from "../src/utils/idKey";
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
	srcName = uniqueDbName("idk_src");
	dstName = uniqueDbName("idk_dst");
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

describe("colisão de chave de _id composto", () => {
	// B6 — o pior: UM delete durante o dump zera o resto do dump inteiro.
	test("dump: 1 _id composto em deletedIds NÃO pode descartar os outros docs", async () => {
		const coll = srcDb.collection("comp");
		await coll.insertMany(
			Array.from({ length: 50 }, (_, i) => ({ _id: { k: i } as never, v: i })),
		);

		// o watch deletou o doc {k: 0} durante o dump e registrou a chave dele.
		const deletedKeys = new Set([idKey({ k: 0 })]);

		const ok = await dumpCollections(
			coll,
			dstDb.collection("comp"),
			deletedKeys,
			{
				batchSize: 10,
			},
		);

		expect(ok).toBe(true);
		// 50 docs, 1 legitimamente deletado => 49 no destino.
		// Com a colisão, "[object Object]" casa com TODOS => 0 copiados.
		expect(await dstDb.collection("comp").countDocuments()).toBe(49);
	});

	// B1 — o buffer do watch colapsa todos os _id compostos numa entrada só.
	test("ChangeBuffer: _ids compostos distintos não podem colapsar numa entrada", () => {
		const buf = new ChangeBuffer();
		buf.add("comp", { k: 1 }, "upsert");
		buf.add("comp", { k: 2 }, "upsert");
		buf.add("comp", { k: 3 }, "upsert");

		expect(buf.size()).toBe(3);
		const drained = buf.drain().get("comp");
		expect(drained?.upserts).toHaveLength(3);
	});

	// B1b — dedupe legítimo (mesmo _id composto) deve continuar funcionando.
	test("ChangeBuffer: mesmo _id composto ainda dedupa, última op vence", () => {
		const buf = new ChangeBuffer();
		buf.add("comp", { k: 1 }, "upsert");
		buf.add("comp", { k: 1 }, "delete");

		expect(buf.size()).toBe(1);
		const drained = buf.drain().get("comp");
		expect(drained?.deletes).toHaveLength(1);
		expect(drained?.upserts).toHaveLength(0);
	});
});
