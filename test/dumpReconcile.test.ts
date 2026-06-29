import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, Db, MongoClient } from "mongodb";
import { dumpCollections } from "../src/core/sync/dumpEvent";
import { setLogConfig } from "../src/utils/logConfig";
import {
	connect,
	DST_URI,
	dropDb,
	SRC_URI,
	seed,
	uniqueDbName,
} from "./helpers";

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
	srcName = uniqueDbName("rec_src");
	dstName = uniqueDbName("rec_dst");
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

/**
 * Embrulha uma collection real fazendo o cursor de `find()` ENCERRAR cedo, SEM
 * lançar erro — simulando o cursor morto que o servidor devolve como "fim limpo"
 * (a raiz do dump truncado em produção). `countDocuments` continua real.
 *
 * `truncations`: quantas vezes os próximos `find()` cortam; demais voltam reais.
 */
function shortCursorCollection(
	real: Collection,
	cutAfter: number,
	truncations: number,
): Collection {
	let left = truncations;
	const proxy = new Proxy(real, {
		get(target, prop, receiver) {
			if (prop === "find") {
				return (...args: unknown[]) => {
					const cursor = (target.find as (...a: unknown[]) => unknown)(...args);
					if (left <= 0) return cursor;
					left -= 1;
					// envólucro mínimo: repassa .sort() ao cursor real e itera só
					// `cutAfter` docs antes de "acabar" (return) sem erro.
					return {
						sort(spec: unknown) {
							(cursor as { sort: (s: unknown) => unknown }).sort(spec);
							return this;
						},
						async *[Symbol.asyncIterator]() {
							let i = 0;
							for await (const d of cursor as AsyncIterable<unknown>) {
								if (i >= cutAfter) return;
								i += 1;
								yield d;
							}
						},
					};
				};
			}
			const v = Reflect.get(target, prop, receiver);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return proxy as unknown as Collection;
}

describe("dumpCollections — guarda de reconciliação (cursor que encerra cedo)", () => {
	test("cursor trunca uma vez → guarda detecta e RETOMA até copiar tudo", async () => {
		await seed(srcDb, "colA", 100); // _id 0..99 (cursor varre 99→0)
		const src = shortCursorCollection(srcDb.collection("colA"), 82, 1);

		const ok = await dumpCollections(src, dstDb.collection("colA"), [], {
			batchSize: 500, // 1 lote: o corte em 82 deixa 18 docs (os _id mais baixos)
		});

		expect(ok).toBe(true);
		// sem a guarda, o destino teria 82; com ela, retoma da fronteira e fecha 100
		expect(await dstDb.collection("colA").countDocuments()).toBe(100);
		expect(
			await dstDb.collection("colA").findOne({ _id: 0 as never }),
		).not.toBeNull();
	});

	test("cursor sempre vazio → NÃO marca completo (retorna false após retries)", async () => {
		await seed(srcDb, "colA", 40);
		// cutAfter 0 + truncations alto: todo find() encerra sem entregar nada
		const src = shortCursorCollection(srcDb.collection("colA"), 0, 999);
		process.env.DUMP_MAX_RETRIES = "2";

		const ok = await dumpCollections(src, dstDb.collection("colA"), [], {
			batchSize: 500,
		});

		process.env.DUMP_MAX_RETRIES = "";
		// varredura nunca avançou → dump NÃO pode ser reportado como concluído
		expect(ok).toBe(false);
		expect(await dstDb.collection("colA").countDocuments()).toBe(0);
	});
});
