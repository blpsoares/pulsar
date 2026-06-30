import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { type Collection, type Db, type MongoClient, ObjectId } from "mongodb";
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
 * Embrulha uma collection real fazendo o cursor de `find()` da VARREDURA encerrar
 * cedo, SEM lançar erro — simulando o cursor morto que o servidor devolve como
 * "fim limpo" (a raiz do dump truncado). `countDocuments` continua real.
 *
 * Só corta a varredura (consumida via `for await`, sem `.limit()`). Queries com
 * `.limit()` (ex.: a detecção min/max de `_id` do dump) passam intactas.
 *
 * `truncations`: quantas varreduras cortam; demais voltam inteiras.
 */
function wrapCursor(
	cursor: { [k: string]: unknown },
	cutAfter: number,
	budget: { left: number },
) {
	let limited = false;
	const proxy: unknown = new Proxy(cursor, {
		get(target, prop) {
			if (prop === "limit") {
				return (...a: unknown[]) => {
					limited = true;
					const r = (target.limit as (...x: unknown[]) => unknown)(...a);
					return r === target ? proxy : r;
				};
			}
			if (prop === Symbol.asyncIterator) {
				const truncate = !limited && budget.left > 0;
				if (!truncate)
					return (target[Symbol.asyncIterator] as () => unknown).bind(target);
				budget.left -= 1;
				return async function* () {
					let i = 0;
					for await (const d of target as AsyncIterable<unknown>) {
						if (i >= cutAfter) return;
						i += 1;
						yield d;
					}
				};
			}
			const v = target[prop as string];
			if (typeof v === "function")
				return (...a: unknown[]) => {
					const r = (v as (...x: unknown[]) => unknown).apply(target, a);
					return r === target ? proxy : r;
				};
			return v;
		},
	});
	return proxy;
}

function shortCursorCollection(
	real: Collection,
	cutAfter: number,
	truncations: number,
): Collection {
	const budget = { left: truncations };
	const proxy = new Proxy(real, {
		get(target, prop, receiver) {
			if (prop === "find") {
				return (...args: unknown[]) =>
					wrapCursor(
						(target.find as (...a: unknown[]) => unknown)(...args) as {
							[k: string]: unknown;
						},
						cutAfter,
						budget,
					);
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

	test("_id MISTO (ObjectId + objeto): copia TUDO, ignora fronteira insegura", async () => {
		// 10 docs com _id ObjectId + 10 com _id objeto composto. No BSON,
		// objeto < ObjectId, então sort({_id:-1}) varre os ObjectId e DEPOIS os objeto.
		const coll = srcDb.collection("mixed");
		await coll.insertMany([
			...Array.from({ length: 10 }, () => ({ _id: new ObjectId(), v: 1 })),
			...Array.from({ length: 10 }, (_, i) => ({
				_id: { k: i } as never,
				v: 2,
			})),
		]);

		// Passa uma fronteira ObjectId — com o $lt type-bracketing ANTIGO, isso
		// pularia os 10 docs de _id objeto (copiaria só 10). Com o fix, o _id não é
		// ObjectId-puro → ignora a fronteira, varre tudo e copia os 20.
		const ok = await dumpCollections(coll, dstDb.collection("mixed"), [], {
			resumeFromId: new ObjectId("ffffffffffffffffffffffff"),
			batchSize: 500,
		});

		expect(ok).toBe(true);
		expect(await dstDb.collection("mixed").countDocuments()).toBe(20);
	});

	test("_id objeto truncado → guarda pela contagem do destino pega e completa", async () => {
		const coll = srcDb.collection("objids");
		await coll.insertMany(
			Array.from({ length: 30 }, (_, i) => ({ _id: { k: i } as never, v: i })),
		);
		// corta a 1ª varredura em 12 docs; a guarda (contagem do destino) deve
		// detectar que faltam 18 e retomar (re-varre do topo) até fechar 30.
		const src = shortCursorCollection(coll, 12, 1);

		const ok = await dumpCollections(src, dstDb.collection("objids"), [], {
			batchSize: 500,
		});

		expect(ok).toBe(true);
		expect(await dstDb.collection("objids").countDocuments()).toBe(30);
	});
});
