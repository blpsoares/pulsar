// test/changeBuffer.test.ts
import { describe, expect, test } from "bun:test";
import { ChangeBuffer } from "../src/core/sync/changeBuffer";

describe("ChangeBuffer", () => {
	test("agrupa upserts e deletes por collection", () => {
		const b = new ChangeBuffer();
		b.add("a", 1, "upsert");
		b.add("a", 2, "delete");
		b.add("b", 3, "upsert");
		expect(b.size()).toBe(3);
		const out = b.drain();
		expect(out.get("a")?.upserts).toEqual([1]);
		expect(out.get("a")?.deletes).toEqual([2]);
		expect(out.get("b")?.upserts).toEqual([3]);
		expect(b.size()).toBe(0);
	});

	test("dedupe: última op vence (upsert depois delete = delete)", () => {
		const b = new ChangeBuffer();
		b.add("a", 1, "upsert");
		b.add("a", 1, "delete");
		expect(b.size()).toBe(1);
		const out = b.drain();
		expect(out.get("a")?.deletes).toEqual([1]);
		expect(out.get("a")?.upserts).toEqual([]);
	});

	test("dedupe: delete depois upsert = upsert", () => {
		const b = new ChangeBuffer();
		b.add("a", 1, "delete");
		b.add("a", 1, "upsert");
		expect(b.size()).toBe(1);
		expect(b.drain().get("a")?.upserts).toEqual([1]);
	});

	test("drain vazio devolve mapa vazio", () => {
		const b = new ChangeBuffer();
		expect(b.drain().size).toBe(0);
		expect(b.size()).toBe(0);
	});
});
