import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/core/ttl/parseDuration";

describe("parseDuration", () => {
	test("converte cada unidade pra segundos", () => {
		expect(parseDuration("30s")).toBe(30);
		expect(parseDuration("30sec")).toBe(30);
		expect(parseDuration("30seconds")).toBe(30);
		expect(parseDuration("5min")).toBe(300);
		expect(parseDuration("5minutes")).toBe(300);
		expect(parseDuration("2h")).toBe(7200);
		expect(parseDuration("2hours")).toBe(7200);
		expect(parseDuration("1d")).toBe(86400);
		expect(parseDuration("1days")).toBe(86400);
		expect(parseDuration("1w")).toBe(604800);
		expect(parseDuration("1weeks")).toBe(604800);
		expect(parseDuration("1mo")).toBe(2592000); // 30 dias
		expect(parseDuration("3months")).toBe(7776000); // 90 dias
		expect(parseDuration("1y")).toBe(31536000); // 365 dias
		expect(parseDuration("2years")).toBe(63072000);
	});

	test("aceita número cru como segundos", () => {
		expect(parseDuration(86400)).toBe(86400);
	});

	test("proíbe 'm' sozinho (ambíguo minuto/mês)", () => {
		expect(() => parseDuration("5m")).toThrow();
	});

	test("rejeita unidade inválida", () => {
		expect(() => parseDuration("5x")).toThrow();
	});

	test("rejeita formato inválido", () => {
		expect(() => parseDuration("abc")).toThrow();
		expect(() => parseDuration("d")).toThrow();
		expect(() => parseDuration("30 d")).toThrow();
	});

	test("rejeita zero ou negativo", () => {
		expect(() => parseDuration("0d")).toThrow();
		expect(() => parseDuration(-5)).toThrow();
	});
});
