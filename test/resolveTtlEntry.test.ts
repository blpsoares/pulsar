import { describe, expect, test } from "bun:test";
import { resolveTtlEntry } from "../src/core/ttl/resolveTtlEntry";

describe("resolveTtlEntry", () => {
	test("string herda field e expire dos defaults", () => {
		const r = resolveTtlEntry("orders", { deriveFromId: true, expire: "30d" });
		expect(r).toEqual({
			name: "orders",
			field: "_created",
			deriveFromId: true,
			expireAfterSeconds: 2592000,
		});
	});

	test("override de field e expire na collection", () => {
		const r = resolveTtlEntry(
			{ name: "sessions", field: "lastActivity", expire: "1h" },
			{ deriveFromId: true, expire: "30d" },
		);
		expect(r).toEqual({
			name: "sessions",
			field: "lastActivity",
			deriveFromId: false,
			expireAfterSeconds: 3600,
		});
	});

	test("expireAfterSeconds cru também funciona", () => {
		const r = resolveTtlEntry(
			{ name: "x", field: "ts", expireAfterSeconds: 10 },
			undefined,
		);
		expect(r.expireAfterSeconds).toBe(10);
	});

	test("erro quando não há field nem deriveFromId", () => {
		expect(() =>
			resolveTtlEntry({ name: "x", expire: "1d" }, undefined),
		).toThrow(/has no TTL field/);
	});

	test("erro quando field e deriveFromId colidem", () => {
		expect(() =>
			resolveTtlEntry(
				{ name: "x", field: "ts", deriveFromId: true, expire: "1d" },
				undefined,
			),
		).toThrow(/mutuamente exclusivos|field.*deriveFromId/);
	});

	test("erro quando falta expire", () => {
		expect(() =>
			resolveTtlEntry({ name: "x", field: "ts" }, undefined),
		).toThrow(/expire/);
	});
});
