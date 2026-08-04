import { describe, expect, test } from "bun:test";
import { Binary, Decimal128, ObjectId } from "mongodb";
import { idKey, idKeySet } from "../src/utils/idKey";

describe("idKey — chave canônica de _id", () => {
	test("_ids compostos distintos geram chaves distintas", () => {
		expect(idKey({ k: 1 })).not.toBe(idKey({ k: 2 }));
		expect(idKey({ a: 1, b: 2 })).not.toBe(idKey({ a: 1, b: 3 }));
	});

	test("ordem das chaves importa (semântica de _id do Mongo)", () => {
		expect(idKey({ a: 1, b: 2 })).not.toBe(idKey({ b: 2, a: 1 }));
	});

	test("mesmo _id composto gera a MESMA chave (dedupe continua valendo)", () => {
		expect(idKey({ a: 1, b: 2 })).toBe(idKey({ a: 1, b: 2 }));
		const oid = new ObjectId();
		expect(idKey(oid)).toBe(idKey(new ObjectId(oid.toHexString())));
	});

	test("tipos escalares distintos não colidem (String(id) colidia)", () => {
		expect(idKey(5)).not.toBe(idKey("5"));
		expect(idKey(true)).not.toBe(idKey("true"));
		expect(idKey(null)).not.toBe(idKey("null"));
	});

	test("cobre tipos BSON usados como _id sem lançar", () => {
		const vals: unknown[] = [
			new ObjectId(),
			"str",
			42,
			3.14,
			true,
			null,
			new Date(0),
			new Binary(new Uint8Array([120, 121])),
			Decimal128.fromString("1.5"),
			{ nested: { deep: [1, 2, 3] } },
			[1, "a", { b: 2 }],
		];
		const keys = vals.map(idKey);
		expect(new Set(keys).size).toBe(vals.length);
	});

	test("idKeySet monta o conjunto de chaves", () => {
		const s = idKeySet([{ k: 1 }, { k: 2 }, { k: 1 }]);
		expect(s.size).toBe(2);
		expect(s.has(idKey({ k: 2 }))).toBe(true);
		expect(s.has(idKey({ k: 3 }))).toBe(false);
	});
});
