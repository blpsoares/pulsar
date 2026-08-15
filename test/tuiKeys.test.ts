/**
 * Testes de comportamento de teclado/geometria compartilhados pelas telas
 * novas da TUI (redesenho do painel de serviços). Cada `describe` cobre uma
 * peça isolada — geometria pura primeiro (`overlayBox`); tasks seguintes do
 * mesmo plano acrescentam `describe`s aqui em vez de espalhar arquivos novos.
 */

import { describe, expect, test } from "bun:test";
import type { ServiceRecord } from "../src/core/state/registry";
import {
	GLOBAL_KEYS,
	helpFor,
	hintsFor,
	KEYS,
	type Layer,
} from "../src/tui/keys";
import { listWindow, overlayBox } from "../src/tui/layout";
import { formatStats } from "../src/tui/screens/ServiceDetail";
import {
	fieldNeedsDestination,
	fieldNeedsSource,
	formatCommaList,
	formatIndexesList,
	needsSudo,
	parseCommaList,
	parseIndexesList,
	visibleFields,
} from "../src/tui/screens/serviceFormFields";

describe("overlayBox", () => {
	test("centraliza a caixa com margem no terminal largo", () => {
		const box = overlayBox(120, 40);
		expect(box.width).toBeLessThan(120);
		expect(box.marginLeft).toBe(Math.floor((120 - box.width) / 2));
		expect(box.marginTop).toBeGreaterThan(0);
	});

	test("abaixo de 60 colunas usa a largura toda", () => {
		// Caixa centralizada num terminal estreito sobra 4 colunas de conteúdo:
		// pior que não ter moldura nenhuma.
		const box = overlayBox(50, 20);
		expect(box.width).toBe(50);
		expect(box.marginLeft).toBe(0);
	});

	test("nunca passa da tela", () => {
		for (const [cols, rows] of [
			[40, 10],
			[80, 24],
			[200, 60],
		] as const) {
			const box = overlayBox(cols, rows);
			expect(box.width + box.marginLeft).toBeLessThanOrEqual(cols);
			expect(box.height + box.marginTop).toBeLessThanOrEqual(rows);
		}
	});
});

describe("listWindow", () => {
	test("lista menor que a altura mostra tudo, começando em 0", () => {
		const win = listWindow(5, 20, 2);
		expect(win).toEqual({ start: 0, end: 5 });
	});

	test("cursor no fim de uma lista longa fica dentro da janela", () => {
		const total = 500;
		const height = 10;
		const cursor = total - 1;
		const win = listWindow(total, height, cursor);
		expect(cursor).toBeGreaterThanOrEqual(win.start);
		expect(cursor).toBeLessThan(win.end);
	});

	test("cursor no começo de uma lista longa fica dentro da janela", () => {
		const win = listWindow(500, 10, 0);
		expect(0).toBeGreaterThanOrEqual(win.start);
		expect(0).toBeLessThan(win.end);
	});

	test("cursor no meio, rolando para baixo e para cima, nunca sai da janela", () => {
		const total = 200;
		const height = 8;

		for (let cursor = 0; cursor < total; cursor++) {
			const win = listWindow(total, height, cursor);
			expect(cursor).toBeGreaterThanOrEqual(win.start);
			expect(cursor).toBeLessThan(win.end);
		}

		// e voltando (rolar para cima) — mesma invariante, sem estado entre chamadas
		for (let cursor = total - 1; cursor >= 0; cursor--) {
			const win = listWindow(total, height, cursor);
			expect(cursor).toBeGreaterThanOrEqual(win.start);
			expect(cursor).toBeLessThan(win.end);
		}
	});

	test("start nunca negativo e end nunca maior que total", () => {
		for (const [total, height] of [
			[0, 10],
			[1, 10],
			[10, 10],
			[10, 3],
			[500, 24],
			[500, 0],
		] as const) {
			for (const cursor of [
				0,
				Math.floor(total / 2),
				total - 1,
				total + 5,
				-5,
			]) {
				const win = listWindow(total, height, cursor);
				expect(win.start).toBeGreaterThanOrEqual(0);
				expect(win.end).toBeLessThanOrEqual(total);
				expect(win.start).toBeLessThanOrEqual(win.end);
			}
		}
	});
});

const LAYERS: Layer[] = ["list", "detail", "form", "logs"];

describe("keys", () => {
	test("toda camada declara pelo menos uma tecla primária", () => {
		for (const layer of LAYERS)
			expect(hintsFor(layer).length).toBeGreaterThan(0);
	});

	test("toda camada tem tecla que só aparece na ajuda", () => {
		// Comparar contra o total da AJUDA (que sempre soma as 3 globais, que
		// nunca são `primary`) tornaria a asserção verdadeira para qualquer
		// dado — inclusive se TODA tecla da camada virasse `primary`, cenário
		// em que a barra tentaria mostrar tudo e o `?` perderia a razão de
		// existir. Por isso a comparação é contra `KEYS[layer]` (só as teclas
		// da própria camada, sem as globais).
		for (const layer of LAYERS)
			expect(hintsFor(layer).length).toBeLessThan(KEYS[layer].length);
	});

	test("nenhuma tecla duplicada dentro da mesma camada", () => {
		for (const layer of LAYERS) {
			const keys = KEYS[layer].map((k) => k.keys);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	test("camada nenhuma redefine uma tecla global", () => {
		// `ctrl+d` sair e `?` ajuda precisam significar a mesma coisa em todo lugar.
		const globais = new Set(GLOBAL_KEYS.map((k) => k.keys));
		for (const layer of LAYERS)
			for (const binding of KEYS[layer])
				expect(globais.has(binding.keys)).toBe(false);
	});

	test("a ajuda de toda camada termina com as globais", () => {
		for (const layer of LAYERS) {
			const grupos = helpFor(layer);
			expect(grupos.at(-1)?.group).toBe("sempre");
			expect(grupos.at(-1)?.keys).toEqual(GLOBAL_KEYS);
		}
	});
});

/** Registro mínimo válido, sobrescrito por teste via spread. */
function record(overrides: Partial<ServiceRecord>): ServiceRecord {
	return {
		name: "pulsar-x",
		mode: "sync",
		config: "configs/x.yml",
		workingDir: ".",
		backend: "systemd",
		boot: true,
		createdBy: "pulsar-tui",
		lastRun: null,
		...overrides,
	};
}

describe("formatStats", () => {
	test("sync traduz os contadores do modo, incluindo resumed/dumped", () => {
		const lines = formatStats(
			record({
				mode: "sync",
				lastRun: {
					startedAt: "2026-08-15T10:00:00.000Z",
					endedAt: "2026-08-15T10:05:00.000Z",
					status: "ok",
					exitCode: 0,
					stats: { collections: 12, resumed: 10, dumped: 2, docs: 15000 },
					error: null,
				},
			}),
		);
		expect(lines).toContain("collections: 12");
		expect(lines).toContain("retomadas: 10");
		expect(lines).toContain("dump completo: 2");
		expect(lines).toContain("documentos copiados: 15.000");
	});

	test("migrate não inventa contador de docs além do que veio nas stats", () => {
		const lines = formatStats(
			record({
				mode: "migrate",
				lastRun: {
					startedAt: "2026-08-15T10:00:00.000Z",
					endedAt: "2026-08-15T10:05:00.000Z",
					status: "ok",
					exitCode: 0,
					stats: { collections: 5 },
					error: null,
				},
			}),
		);
		// mongodump roda como processo filho e não expõe contagem de docs — só
		// o que de fato veio em `stats` aparece, nada é inventado.
		expect(lines).toEqual(["collections: 5"]);
	});

	test("ttl traduz índices e materializados, sem usar rótulos de sync", () => {
		const lines = formatStats(
			record({
				mode: "ttl",
				lastRun: {
					startedAt: "2026-08-15T10:00:00.000Z",
					endedAt: "2026-08-15T10:05:00.000Z",
					status: "ok",
					exitCode: 0,
					stats: { collections: 3, indexes: 3, materialized: 4000 },
					error: null,
				},
			}),
		);
		expect(lines).toContain("índices TTL criados: 3");
		expect(lines).toContain("documentos com _created: 4.000");
		expect(lines.some((l) => l.startsWith("índices criados"))).toBe(false);
	});

	test("stats vazio (ou sem lastRun) devolve lista vazia", () => {
		expect(formatStats(record({ lastRun: null }))).toEqual([]);
		expect(
			formatStats(
				record({
					lastRun: {
						startedAt: "2026-08-15T10:00:00.000Z",
						endedAt: null,
						status: "running",
						exitCode: null,
						stats: {},
						error: null,
					},
				}),
			),
		).toEqual([]);
	});
});

describe("serviceFormFields (Task 13 — formulário único)", () => {
	test("visibleFields: sync tem os 12 campos, incluindo views/índices", () => {
		expect(visibleFields("sync")).toEqual([
			"name",
			"mode",
			"config",
			"sourceUri",
			"sourceDb",
			"destUri",
			"destDb",
			"collections",
			"views",
			"indexes",
			"backend",
			"boot",
		]);
	});

	test("visibleFields: migrate tem destino mas não views/índices nem campos de ttl", () => {
		const fields = visibleFields("migrate");
		expect(fields).toContain("destUri");
		expect(fields).toContain("destDb");
		expect(fields).not.toContain("views");
		expect(fields).not.toContain("indexes");
		expect(fields).not.toContain("ttlField");
		expect(fields).not.toContain("ttlDeriveFromId");
		expect(fields).not.toContain("ttlExpire");
	});

	test("visibleFields: sync não tem campos de ttl", () => {
		const fields = visibleFields("sync");
		expect(fields).not.toContain("ttlField");
		expect(fields).not.toContain("ttlDeriveFromId");
		expect(fields).not.toContain("ttlExpire");
	});

	test("visibleFields: ttl não tem destino nem views/índices — opera num banco só", () => {
		const fields = visibleFields("ttl");
		expect(fields).not.toContain("destUri");
		expect(fields).not.toContain("destDb");
		expect(fields).not.toContain("views");
		expect(fields).not.toContain("indexes");
		// mas collections continua existindo: o ttl ainda escolhe em quais criar o índice
		expect(fields).toContain("collections");
	});

	test("visibleFields: ttl tem os 3 campos de defaults (Fix 1 da Rodada 1) — 11 campos ao todo", () => {
		const fields = visibleFields("ttl");
		expect(fields).toEqual([
			"name",
			"mode",
			"config",
			"sourceUri",
			"sourceDb",
			"collections",
			"ttlField",
			"ttlDeriveFromId",
			"ttlExpire",
			"backend",
			"boot",
		]);
	});

	test("visibleFields nunca esconde um campo por FALTAR conexão — só por modo", () => {
		// origem.db/collections aparecem sempre, independente de estar conectado
		// (o componente é quem decide desabilitar/mostrar o motivo, não esta função).
		for (const mode of ["sync", "migrate", "ttl"] as const) {
			expect(visibleFields(mode)).toContain("sourceDb");
			expect(visibleFields(mode)).toContain("collections");
		}
	});

	test("fieldNeedsSource marca só os campos que dependem da conexão de ORIGEM", () => {
		expect(fieldNeedsSource("sourceDb")).toBe(true);
		expect(fieldNeedsSource("collections")).toBe(true);
		expect(fieldNeedsSource("views")).toBe(true);
		expect(fieldNeedsSource("indexes")).toBe(true);
		expect(fieldNeedsSource("destDb")).toBe(false);
		expect(fieldNeedsSource("name")).toBe(false);
	});

	test("fieldNeedsDestination marca só destino.db", () => {
		expect(fieldNeedsDestination("destDb")).toBe(true);
		expect(fieldNeedsDestination("sourceDb")).toBe(false);
		expect(fieldNeedsDestination("destUri")).toBe(false);
	});

	test("needsSudo: só docker/pm2/systemd — launchd normalmente não pede", () => {
		expect(needsSudo("docker")).toBe(true);
		expect(needsSudo("pm2")).toBe(true);
		expect(needsSudo("systemd")).toBe(true);
		expect(needsSudo("launchd")).toBe(false);
	});

	test("parseCommaList/formatCommaList fazem ida e volta, ignorando espaços e vazios", () => {
		expect(parseCommaList("a, b ,  c,,")).toEqual(["a", "b", "c"]);
		expect(parseCommaList("")).toEqual([]);
		expect(formatCommaList(["a", "b", "c"])).toBe("a, b, c");
	});

	test("parseIndexesList agrupa por collection a partir de 'collection.índice'", () => {
		expect(
			parseIndexesList("orders.status_1, orders.date_-1, users.email_1"),
		).toEqual([
			{ collection: "orders", indexes: ["status_1", "date_-1"] },
			{ collection: "users", indexes: ["email_1"] },
		]);
	});

	test("parseIndexesList ignora entrada sem '.' (não dá pra saber a collection)", () => {
		expect(parseIndexesList("status_1, orders.date_-1")).toEqual([
			{ collection: "orders", indexes: ["date_-1"] },
		]);
	});

	test("formatIndexesList é o inverso de parseIndexesList para o formato achatado", () => {
		const parsed = parseIndexesList("orders.status_1, orders.date_-1");
		expect(formatIndexesList(parsed)).toBe("orders.status_1, orders.date_-1");
	});

	test("formatIndexesList devolve vazio para true/false (não há o que digitar de volta)", () => {
		expect(formatIndexesList(true)).toBe("");
		expect(formatIndexesList(false)).toBe("");
	});
});
