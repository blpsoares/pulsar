import { describe, expect, test } from "bun:test";
import { isTransientConnError } from "../src/db/conn";

describe("isTransientConnError", () => {
	test("timeout de handshake (o caso real do Atlas) → transitório", () => {
		expect(
			isTransientConnError(
				new Error("Socket 'secureConnect' timed out after 30001ms"),
			),
		).toBe(true);
	});

	test("erros de rede por name/code → transitório", () => {
		expect(isTransientConnError({ name: "MongoServerSelectionError" })).toBe(
			true,
		);
		expect(isTransientConnError({ name: "MongoNetworkTimeoutError" })).toBe(
			true,
		);
		expect(isTransientConnError({ code: "ECONNREFUSED" })).toBe(true);
		expect(isTransientConnError({ code: "ETIMEDOUT" })).toBe(true);
		expect(isTransientConnError(new Error("connection 5 to host closed"))).toBe(
			true,
		);
	});

	test("erro de auth/URI → NÃO transitório (não adianta retentar)", () => {
		expect(isTransientConnError(new Error("Authentication failed."))).toBe(
			false,
		);
		expect(isTransientConnError(new Error("Invalid connection string"))).toBe(
			false,
		);
		expect(isTransientConnError(null)).toBe(false);
		expect(isTransientConnError(undefined)).toBe(false);
	});
});
