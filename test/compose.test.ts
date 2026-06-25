import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInstanceCompose } from "../src/core/compose/buildCompose";
import { classifyConfig } from "../src/core/compose/detectConfigs";
import { recommendResources } from "../src/core/compose/recommend";

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

const BASE = readFileSync(
	fileURLToPath(new URL("../docker-compose-limit.yml", import.meta.url)),
	"utf8",
);

describe("recommendResources (baseado no uso)", () => {
	test("sem nada comprometido: ~65% da RAM e ~1 núcleo livre", () => {
		const r = recommendResources(8 * GiB, 4);
		expect(r.memLimitMiB).toBe(Math.floor((8 * GiB * 0.65) / MiB));
		expect(r.memReservMiB).toBe(Math.floor(r.memLimitMiB * 0.5));
		expect(r.cpus).toBe(3);
	});

	test("subtrai o que as instâncias existentes já comprometeram", () => {
		const budgetMiB = Math.floor((8 * GiB * 0.65) / MiB);
		const committedMem = 2 * GiB;
		const r = recommendResources(8 * GiB, 4, committedMem, 1.5);
		expect(r.memLimitMiB).toBe(budgetMiB - Math.floor(committedMem / MiB));
		expect(r.cpus).toBe(1.5); // (4-1) - 1.5
	});

	test("nunca abaixo do piso (RAM 256m, cpu 0.25)", () => {
		const r = recommendResources(2 * GiB, 2, 4 * GiB, 5);
		expect(r.memLimitMiB).toBe(256);
		expect(r.cpus).toBe(0.25);
	});
});

describe("classifyConfig", () => {
	test("sync com origem/destino", () => {
		const r = classifyConfig({
			command: {
				sync: { source: { db: "aurora" }, destination: { db: "ads-staging" } },
			},
		});
		expect(r).toEqual({
			kind: "sync",
			sourceDb: "aurora",
			destDb: "ads-staging",
		});
	});
	test("ttl", () => {
		expect(
			classifyConfig({ command: { ttl: { source: { db: "x" } } } }).kind,
		).toBe("ttl");
	});
	test("migrate", () => {
		expect(classifyConfig({ command: { migrate: {} } }).kind).toBe("migrate");
	});
	test("desconhecido", () => {
		expect(classifyConfig({ foo: 1 }).kind).toBe("desconhecido");
		expect(classifyConfig(null).kind).toBe("desconhecido");
	});
});

describe("buildInstanceCompose", () => {
	const out = buildInstanceCompose(BASE, {
		suffix: "2",
		configPath: "configs/sync2.yml",
		res: { memLimitMiB: 1200, memReservMiB: 600, cpus: 0.8 },
	});

	test("renomeia serviço e container", () => {
		expect(out).toContain("  pulsar-sync-2:");
		expect(out).toContain("container_name: pulsar-sync-2");
	});
	test("aponta command e volume pra nova config", () => {
		expect(out).toContain('"pulsar", "sync", "configs/sync2.yml"');
		expect(out).toContain("./configs/sync2.yml:/app/configs/sync2.yml:ro");
		expect(out).not.toContain("./configs/sync.yml:/app/configs/sync.yml:ro");
	});
	test("volume de logs próprio", () => {
		expect(out).toContain("./logs-2:/app/logs");
	});
	test("aplica recursos (sem NaN)", () => {
		expect(out).toContain("mem_limit: 1200m");
		expect(out).toContain("memswap_limit: 1200m");
		expect(out).toContain("mem_reservation: 600m");
		expect(out).toContain("cpus: 0.8");
		expect(out).not.toContain("NaN");
	});
});
