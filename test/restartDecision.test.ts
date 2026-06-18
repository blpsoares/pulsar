import { describe, expect, test } from "bun:test";
import {
	decideStartupAction,
	isHistoryLostError,
} from "../src/core/sync/restartDecision";

describe("decideStartupAction", () => {
	test("dump quando nunca terminou (sem carimbo)", () => {
		expect(decideStartupAction({}, { full: false })).toBe("dump");
	});

	test("dump quando terminou mas não tem token", () => {
		expect(decideStartupAction({ dumpCompletedAt: 123 }, { full: false })).toBe(
			"dump",
		);
	});

	test("resume quando terminou e tem token", () => {
		expect(
			decideStartupAction(
				{ dumpCompletedAt: 123, resumeToken: { _data: "82AB" } },
				{ full: false },
			),
		).toBe("resume");
	});

	test("--full força dump mesmo com carimbo e token", () => {
		expect(
			decideStartupAction(
				{ dumpCompletedAt: 123, resumeToken: { _data: "82AB" } },
				{ full: true },
			),
		).toBe("dump");
	});
});

describe("isHistoryLostError", () => {
	test("true para code 286", () => {
		expect(isHistoryLostError({ code: 286 })).toBe(true);
	});

	test("true para codeName ChangeStreamHistoryLost", () => {
		expect(isHistoryLostError({ codeName: "ChangeStreamHistoryLost" })).toBe(
			true,
		);
	});

	test("false para erro transitório genérico", () => {
		expect(isHistoryLostError({ code: 89, codeName: "NetworkTimeout" })).toBe(
			false,
		);
	});

	test("false para não-objeto", () => {
		expect(isHistoryLostError(undefined)).toBe(false);
		expect(isHistoryLostError("boom")).toBe(false);
	});
});
