/**
 * Testes de comportamento de teclado/geometria compartilhados pelas telas
 * novas da TUI (redesenho do painel de serviços). Cada `describe` cobre uma
 * peça isolada — geometria pura primeiro (`overlayBox`); tasks seguintes do
 * mesmo plano acrescentam `describe`s aqui em vez de espalhar arquivos novos.
 */

import { describe, expect, test } from "bun:test";
import {
	GLOBAL_KEYS,
	helpFor,
	hintsFor,
	KEYS,
	type Layer,
} from "../src/tui/keys";
import { listWindow, overlayBox } from "../src/tui/layout";

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
