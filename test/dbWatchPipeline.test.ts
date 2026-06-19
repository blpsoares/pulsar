import { describe, expect, test } from "bun:test";
import { buildDbWatchPipeline } from "../src/core/sync/dbWatchPipeline";

describe("buildDbWatchPipeline — recorta o db.watch nas X collections", () => {
	test("collections sem filtro viram cláusulas por ns.coll", () => {
		const p = buildDbWatchPipeline([{ name: "a" }, { name: "b" }]);
		expect(p).toEqual([
			{ $match: { $or: [{ "ns.coll": "a" }, { "ns.coll": "b" }] } },
		]);
	});

	test("collection com filtro: delete sempre passa + não-delete casa o filtro no fullDocument", () => {
		const p = buildDbWatchPipeline([
			{ name: "orders", filter: { status: "active" } },
		]);
		expect(p).toEqual([
			{
				$match: {
					$or: [
						{ "ns.coll": "orders", operationType: "delete" },
						{ "ns.coll": "orders", "fullDocument.status": "active" },
					],
				},
			},
		]);
	});

	test("mistura filtradas e não-filtradas", () => {
		const p = buildDbWatchPipeline([
			{ name: "a" },
			{ name: "orders", filter: { status: "active" } },
		]);
		expect(p).toEqual([
			{
				$match: {
					$or: [
						{ "ns.coll": "a" },
						{ "ns.coll": "orders", operationType: "delete" },
						{ "ns.coll": "orders", "fullDocument.status": "active" },
					],
				},
			},
		]);
	});

	test("lista vazia → pipeline vazio", () => {
		expect(buildDbWatchPipeline([])).toEqual([]);
	});
});
