import { describe, expect, test } from "bun:test";
import Bottleneck from "bottleneck";
import { initMigration, isNamespaceMissing } from "../src/core/dump/dump";

type DumpResult = [string[], string[], string[]]; // [success, failed, missing]

/**
 * Constrói um dumper falso (injetável no initMigration) a partir de um
 * classificador por collection. O classificador recebe (collection, attempt)
 * e devolve "success" | "failed" (transitório) | "missing" (não existe).
 * Também registra quantas vezes cada collection foi tentada.
 */
function fakeDumper(
	classify: (
		collection: string,
		attempt: number,
	) => "success" | "failed" | "missing",
) {
	const calls = new Map<string, number>();
	const dumpFn = async (collections: string[]): Promise<DumpResult> => {
		const success: string[] = [];
		const failed: string[] = [];
		const missing: string[] = [];
		for (const c of collections) {
			const attempt = (calls.get(c) ?? 0) + 1;
			calls.set(c, attempt);
			const verdict = classify(c, attempt);
			if (verdict === "success") success.push(c);
			else if (verdict === "missing") missing.push(c);
			else failed.push(c);
		}
		return [success, failed, missing];
	};
	return { dumpFn, calls };
}

const SRC = { uri: "mongodb://x", db: "__test_no_tempdump__" };
const OUT = "/tmp/__pulsar_test_out__";
const limiter = new Bottleneck({ maxConcurrent: 2 });

describe("isNamespaceMissing", () => {
	test("true quando o stderr diz que a collection não existe", () => {
		expect(
			isNamespaceMissing(
				"namespace with DB ads-staging and collection dados_novo does not exist",
			),
		).toBe(true);
	});

	test("false para falha transitória de conexão", () => {
		expect(
			isNamespaceMissing(
				"connection() error occurred during connection handshake: connection refused",
			),
		).toBe(false);
	});

	test("false para stderr vazio", () => {
		expect(isNamespaceMissing("")).toBe(false);
	});
});

describe("initMigration — skip de collection inexistente + continuar", () => {
	test("collection inexistente é pulada SEM retry e não derruba a migração", async () => {
		const { dumpFn, calls } = fakeDumper((c) =>
			c === "ausente" ? "missing" : "success",
		);

		const result = await initMigration(
			SRC,
			OUT,
			limiter,
			["existe", "ausente"],
			"",
			3,
			dumpFn,
		);

		expect(result).toContain("existe");
		expect(result).not.toContain("ausente");
		// missing nunca é retentado
		expect(calls.get("ausente")).toBe(1);
	});

	test("falha transitória é retentada e, ao sucesso, entra no resultado", async () => {
		const { dumpFn, calls } = fakeDumper((c, attempt) =>
			c === "flaky" && attempt < 2 ? "failed" : "success",
		);

		const result = await initMigration(
			SRC,
			OUT,
			limiter,
			["flaky"],
			"",
			3,
			dumpFn,
		);

		expect(result).toContain("flaky");
		expect(calls.get("flaky")).toBe(2);
	});

	test("falha transitória persistente esgota retries, é logada e não derruba (mas é excluída)", async () => {
		const { dumpFn, calls } = fakeDumper((c) =>
			c === "ruim" ? "failed" : "success",
		);

		const result = await initMigration(
			SRC,
			OUT,
			limiter,
			["boa", "ruim"],
			"",
			2,
			dumpFn,
		);

		expect(result).toContain("boa");
		expect(result).not.toContain("ruim");
		expect(calls.get("ruim")).toBe(2); // tentou maxRetries vezes
	});

	test("aborta (throw) somente quando NADA foi exportado", async () => {
		const { dumpFn } = fakeDumper(() => "missing");

		await expect(
			initMigration(SRC, OUT, limiter, ["ausente"], "", 3, dumpFn),
		).rejects.toBeDefined();
	});
});
