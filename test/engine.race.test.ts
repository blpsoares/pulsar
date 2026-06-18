import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { SyncEngine } from "../src/core/sync/engine";
import { setLogConfig } from "../src/utils/logConfig";
import {
	connect,
	DST_URI,
	dropDb,
	SRC_URI,
	seed,
	sleep,
	uniqueDbName,
	waitFor,
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
	srcName = uniqueDbName("race_src");
	dstName = uniqueDbName("race_dst");
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

describe("SyncEngine — race: mudança ao vivo durante o dump", () => {
	test("update ao vivo durante o dump vence (hot) e não é sobrescrito", async () => {
		// Muitos docs pra alargar a janela do dump; _id baixos processados por
		// último (sort _id:-1).
		await seed(srcDb, "big", 6000);

		const engine = new SyncEngine({
			sourceDb: srcDb,
			destDb: dstDb,
			collections: [{ name: "big" }],
			batchSize: 500,
			checkpointIntervalMs: 100,
		});

		const started = engine.start(); // NÃO aguarda — dump em andamento

		// Deixa o change stream abrir, então dispara updates ao vivo nos _id baixos
		// (que o cursor só alcançaria no fim).
		await sleep(60);
		for (let i = 0; i < 10; i++) {
			await srcDb
				.collection("big")
				.updateOne({ _id: i as any }, { $set: { v: `LIVE_${i}` } });
		}

		await started; // dump terminou
		await sleep(300); // assenta eventos ao vivo

		// A versão ao vivo venceu em todos os 10
		const ok = await waitFor(async () => {
			const docs = await dstDb
				.collection("big")
				.find({ _id: { $in: Array.from({ length: 10 }, (_, i) => i as any) } })
				.toArray();
			return (
				docs.length === 10 &&
				docs.every(
					(d) => String(d.v).startsWith("LIVE_") && d.__sync?.hot === true,
				)
			);
		}, 5000);
		expect(ok).toBe(true);

		await engine.stop();
	});
});
