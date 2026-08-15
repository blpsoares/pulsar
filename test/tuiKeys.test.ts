/**
 * Testes de comportamento de teclado/geometria compartilhados pelas telas
 * novas da TUI (redesenho do painel de serviços). Cada `describe` cobre uma
 * peça isolada — geometria pura primeiro (`overlayBox`); tasks seguintes do
 * mesmo plano acrescentam `describe`s aqui em vez de espalhar arquivos novos.
 */

import { describe, expect, test } from "bun:test";
import { overlayBox } from "../src/tui/layout";

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
