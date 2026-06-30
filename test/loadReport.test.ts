import { describe, expect, test } from "bun:test";
import { formatDuration, formatLoadReport } from "../src/utils/loadReport";

describe("formatDuration", () => {
	test("só segundos", () => expect(formatDuration(45_000)).toBe("45s"));
	test("zero", () => expect(formatDuration(0)).toBe("0s"));
	test("negativo vira 0s", () => expect(formatDuration(-5)).toBe("0s"));
	test("minutos e segundos", () =>
		expect(formatDuration(90_000)).toBe("1m 30s"));
	test("37m 48s", () =>
		expect(formatDuration((37 * 60 + 48) * 1000)).toBe("37m 48s"));
	test("horas com pad nos segundos", () =>
		expect(formatDuration((3600 + 5 * 60 + 3) * 1000)).toBe("1h 5m 03s"));
});

describe("formatLoadReport", () => {
	test("monta a linha com count, horários e total", () => {
		const start = 1_700_000_000_000;
		const end = start + (37 * 60 + 48) * 1000;
		const line = formatLoadReport(50, start, end);
		expect(line).toContain("50 collections");
		expect(line).toContain("total 37m 48s");
		expect(line).toMatch(/start \d{2}:\d{2}:\d{2}/);
		expect(line).toMatch(/end \d{2}:\d{2}:\d{2}/);
	});
});
