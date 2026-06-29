import { describe, expect, test } from "bun:test";
import { buildDbWatchPipeline } from "../src/core/sync/dbWatchPipeline";

describe("buildDbWatchPipeline — recorta o db.watch nas X collections", () => {
	test("collections sem filtro viram cláusulas por ns.coll", () => {
		const p = buildDbWatchPipeline([{ name: "a" }, { name: "b" }]);
		expect(p).toEqual([
			{ $match: { $or: [{ "ns.coll": "a" }, { "ns.coll": "b" }] } },
			{ $project: { fullDocument: 0, updateDescription: 0 } },
		]);
	});

	test("collection com filtro: $match casa só por ns.coll (filtro vai pra re-busca)", () => {
		const p = buildDbWatchPipeline([
			{ name: "orders", filter: { status: "active" } },
		]);
		expect(p).toEqual([
			{
				$match: {
					$or: [{ "ns.coll": "orders" }],
				},
			},
			{ $project: { fullDocument: 0, updateDescription: 0 } },
		]);
	});

	test("mistura filtradas e não-filtradas: $match só por ns.coll pra todas", () => {
		const p = buildDbWatchPipeline([
			{ name: "a" },
			{ name: "orders", filter: { status: "active" } },
		]);
		expect(p).toEqual([
			{
				$match: {
					$or: [{ "ns.coll": "a" }, { "ns.coll": "orders" }],
				},
			},
			{ $project: { fullDocument: 0, updateDescription: 0 } },
		]);
	});

	test("lista vazia → pipeline vazio", () => {
		expect(buildDbWatchPipeline([])).toEqual([]);
	});

	test("não usa filtro no $match e projeta fora fullDocument/updateDescription", () => {
		const p = buildDbWatchPipeline([
			{ name: "a" },
			{ name: "b", filter: { status: "active" } },
		]);
		// último stage = $project removendo os campos grandes
		const project = p[p.length - 1];
		expect(project).toEqual({
			$project: { fullDocument: 0, updateDescription: 0 },
		});
		// $match casa só por ns.coll (uma cláusula por collection), sem filtro
		const match = p[0] as { $match: { $or: Array<Record<string, unknown>> } };
		expect(match.$match.$or).toEqual([{ "ns.coll": "a" }, { "ns.coll": "b" }]);
	});
});
