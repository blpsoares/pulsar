import { BSON, type Collection, type Document, MongoClient, ObjectId } from "mongodb";
import { createHash } from "node:crypto";

// ----- config -----
const URI = process.env.BENCH_URI ?? "mongodb://localhost:27099";
const N = Number(process.env.BENCH_N ?? 100000);
const PAGE = Number(process.env.BENCH_PAGE ?? 500);
const SRC_DB = "benchsrc";
const DST_DB = "benchdst";
const COLL = "sim";

// ----- helpers (espelham src/utils/mongo.ts) -----
function hashDoc(doc: Document): string {
	return createHash("SHA-1").update(BSON.serialize(doc)).digest("hex");
}
function addFields(raw: Document, origin: string, hot: boolean): Document {
	const hash = hashDoc(raw);
	return { ...raw, __sync: { hot, ts: 0, hash }, origin };
}

// contadores de round-trips
let reads = 0;
let writes = 0;
function resetCounters() {
	reads = 0;
	writes = 0;
}

// ----- estratégia ATUAL: 1 findOne + 1 write por doc -----
async function strategyCurrent(src: Collection, dst: Collection) {
	resetCounters();
	const cursor = src.find({}).sort({ _id: -1 });
	for await (const cold of cursor) {
		if (!cold?._id) continue;
		const newDoc = addFields(cold, "dump", false);
		const sourceHash = (newDoc.__sync as any).hash;

		const destDoc = await dst.findOne(
			{ _id: cold._id },
			{ projection: { "__sync.hot": 1, "__sync.hash": 1 } },
		);
		reads++;

		if (destDoc === null) {
			await dst.insertOne(newDoc);
			writes++;
			continue;
		}
		if (destDoc.__sync?.hot === true || destDoc.__sync?.hash === sourceHash) continue;
		await dst.updateOne({ _id: cold._id }, { $set: newDoc });
		writes++;
	}
}

// ----- estratégia BATCH: find($in) por pagina + bulkWrite -----
async function strategyBatch(src: Collection, dst: Collection) {
	resetCounters();
	const cursor = src.find({}).sort({ _id: -1 });
	let page: Document[] = [];

	async function flush() {
		if (!page.length) return;
		const ids = page.map((d) => d._id);
		const existing = await dst
			.find({ _id: { $in: ids } }, { projection: { "__sync.hot": 1, "__sync.hash": 1 } })
			.toArray();
		reads++;
		const map = new Map(existing.map((d) => [String(d._id), d]));

		const ops: any[] = [];
		for (const cold of page) {
			const newDoc = addFields(cold, "dump", false);
			const sourceHash = (newDoc.__sync as any).hash;
			const destDoc = map.get(String(cold._id));
			if (!destDoc) {
				ops.push({ replaceOne: { filter: { _id: cold._id }, replacement: newDoc, upsert: true } });
				continue;
			}
			if (destDoc.__sync?.hot === true || destDoc.__sync?.hash === sourceHash) continue;
			// preserva docs marcados hot pelo change stream
			ops.push({
				updateOne: {
					filter: { _id: cold._id, "__sync.hot": { $ne: true } },
					update: { $set: newDoc },
				},
			});
		}
		if (ops.length) {
			await dst.bulkWrite(ops, { ordered: false });
			writes++;
		}
		page = [];
	}

	for await (const cold of cursor) {
		if (!cold?._id) continue;
		page.push(cold);
		if (page.length >= PAGE) await flush();
	}
	await flush();
}

async function seed(src: Collection) {
	const have = await src.estimatedDocumentCount();
	if (have >= N) {
		console.log(`origem ja tem ${have} docs, pulando seed`);
		return;
	}
	console.log(`semeando ${N} docs na origem...`);
	const payload = "x".repeat(800);
	let batch: Document[] = [];
	for (let i = 0; i < N; i++) {
		batch.push({
			_id: new ObjectId(),
			geohash: (i * 7919).toString(36),
			lat: (i % 9000) / 100,
			lng: (i % 18000) / 100,
			valor: i % 1000,
			ativo: i % 2 === 0,
			tags: [`t${i % 50}`, `g${i % 13}`],
			payload,
		});
		if (batch.length >= 5000) {
			await src.insertMany(batch, { ordered: false });
			batch = [];
		}
	}
	if (batch.length) await src.insertMany(batch, { ordered: false });
	console.log("seed pronto");
}

async function run() {
	const client = new MongoClient(URI);
	await client.connect();
	const src = client.db(SRC_DB).collection(COLL);
	const dst = client.db(DST_DB).collection(COLL);

	await seed(src);

	const results: Record<string, { ms: number; reads: number; writes: number }> = {};

	// COLD: destino vazio (tudo insert)
	await dst.drop().catch(() => {});
	let t = performance.now();
	await strategyCurrent(src, dst);
	results["atual COLD (insert)"] = { ms: performance.now() - t, reads, writes };

	// ATUAL WARM: destino cheio (tudo skip) — cenario de restart
	t = performance.now();
	await strategyCurrent(src, dst);
	results["atual WARM (skip/restart)"] = { ms: performance.now() - t, reads, writes };

	// BATCH COLD
	await dst.drop().catch(() => {});
	t = performance.now();
	await strategyBatch(src, dst);
	results["batch COLD (insert)"] = { ms: performance.now() - t, reads, writes };

	// BATCH WARM
	t = performance.now();
	await strategyBatch(src, dst);
	results["batch WARM (skip/restart)"] = { ms: performance.now() - t, reads, writes };

	console.log(`\n=== RESULTADOS (N=${N}, page=${PAGE}) ===`);
	for (const [k, v] of Object.entries(results)) {
		console.log(
			`${k.padEnd(30)} | ${(v.ms / 1000).toFixed(1).padStart(7)}s | reads ${String(v.reads).padStart(7)} | writes ${String(v.writes).padStart(7)}`,
		);
	}

	await client.close();
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
