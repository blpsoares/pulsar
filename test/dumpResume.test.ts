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
	srcName = uniqueDbName("dr_src");
	dstName = uniqueDbName("dr_dst");
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

describe("dumpCollections — retomada por fronteira (resumeFromId)", () => {
	test("resumeFromId só processa docs com _id menor que a fronteira", async () => {
		await seed(srcDb, "colA", 100); // _id 0..99

		const ok = await dumpCollections(
			srcDb.collection("colA"),
			dstDb.collection("colA"),
			[],
			{
				batchSize: 20,
				resumeFromId: 50,
			},
		);
		expect(ok).toBe(true);

		// só 0..49 entraram (50 docs); nada de 50..99
		expect(await dstDb.collection("colA").countDocuments()).toBe(50);
		expect(
			await dstDb.collection("colA").findOne({ _id: 49 as any }),
		).not.toBeNull();
		expect(
			await dstDb.collection("colA").findOne({ _id: 50 as any }),
		).toBeNull();
		expect(
			await dstDb.collection("colA").findOne({ _id: 99 as any }),
		).toBeNull();
	});

	test("onProgress reporta fronteiras decrescentes (última = menor _id)", async () => {
		await seed(srcDb, "colA", 60); // _id 0..59

		const seen: number[] = [];
		await dumpCollections(
			srcDb.collection("colA"),
			dstDb.collection("colA"),
			[],
			{
				batchSize: 20,
				onProgress: (id) => seen.push(id as number),
			},
		);

		expect(seen.length).toBeGreaterThan(0);
		// cursor varre _id desc → fronteiras caem; a última é o menor _id (0)
		expect(seen[seen.length - 1]).toBe(0);
	});
});
