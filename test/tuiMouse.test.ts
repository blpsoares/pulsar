import { describe, expect, test } from "bun:test";
import { describeCopy } from "../src/core/clipboard";
import { buildRows } from "../src/tui/components/ConfigTree";
import { isMouseInput, parseMouse } from "../src/tui/mouse/parse";

/**
 * Parsing do protocolo de mouse e agrupamento da árvore de configs — as duas
 * peças puras do clique. O resto (hit-testing sobre a árvore do ink) é
 * verificado dirigindo a TUI num pty de verdade.
 */

describe("protocolo de mouse (SGR 1006)", () => {
	test("interpreta clique, com coordenadas 0-based", () => {
		const { events } = parseMouse("\x1b[<0;21;9M");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "press", x: 20, y: 8, button: 0 });
	});

	test("distingue pressionar de soltar", () => {
		expect(parseMouse("\x1b[<0;5;5m").events[0]?.kind).toBe("release");
	});

	test("roda do mouse vira wheel-up/wheel-down", () => {
		expect(parseMouse("\x1b[<64;5;5M").events[0]?.kind).toBe("wheel-up");
		expect(parseMouse("\x1b[<65;5;5M").events[0]?.kind).toBe("wheel-down");
	});

	test("modificadores são extraídos do bitfield", () => {
		// 0 + 4 (shift) + 16 (ctrl)
		const event = parseMouse("\x1b[<20;5;5M").events[0];
		expect(event?.shift).toBe(true);
		expect(event?.ctrl).toBe(true);
		expect(event?.alt).toBe(false);
	});

	test("lê vários eventos de um chunk só", () => {
		const { events } = parseMouse("\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<65;2;2M");
		expect(events.map((e) => e.kind)).toEqual([
			"press",
			"release",
			"wheel-down",
		]);
	});

	test("guarda sequência partida entre chunks", () => {
		const first = parseMouse("texto\x1b[<0;10");
		expect(first.events).toHaveLength(0);
		expect(first.rest).toContain("[<0;10");

		const second = parseMouse(`${first.rest};5M`);
		expect(second.events[0]).toMatchObject({ x: 9, y: 4 });
	});

	test("reconhece a sequência como o ink a entrega (sem ESC)", () => {
		// Verificado na prática: o ink entrega o corpo do escape como "texto"
		expect(isMouseInput("[<0;10;5M")).toBe(true);
		expect(isMouseInput("\x1b[<0;10;5M")).toBe(true);
		expect(isMouseInput("j")).toBe(false);
		expect(isMouseInput("[<0;10;5")).toBe(false);
	});
});

describe("árvore de configs", () => {
	const configs = [
		{ file: "raiz.yml", kind: "sync" as const },
		{ file: "configs/a.yml", kind: "sync" as const },
		{ file: "configs/b.yml", kind: "ttl" as const },
		{ file: "infra/k8s/c.yml", kind: "migrate" as const },
	];

	test("agrupa por pasta, com o diretório atual primeiro", () => {
		const rows = buildRows(configs, new Set());
		expect(rows[0]).toMatchObject({ kind: "group", dir: ".", count: 1 });
		expect(rows[1]).toMatchObject({ kind: "item" });

		const dirs = rows
			.filter((r) => r.kind === "group")
			.map((r) => (r.kind === "group" ? r.dir : ""));
		// "." primeiro, depois o mais raso, depois alfabético
		expect(dirs).toEqual([".", "configs", "infra/k8s"]);
	});

	test("seção fechada esconde os itens mas mantém a contagem", () => {
		const rows = buildRows(configs, new Set(["configs"]));
		const group = rows.find((r) => r.kind === "group" && r.dir === "configs");
		expect(group).toMatchObject({ collapsed: true, count: 2 });
		expect(
			rows.some((r) => r.kind === "item" && r.config.file.startsWith("configs/")),
		).toBe(false);
	});

	test("fechar tudo deixa só os cabeçalhos", () => {
		const rows = buildRows(configs, new Set([".", "configs", "infra/k8s"]));
		expect(rows.every((r) => r.kind === "group")).toBe(true);
		expect(rows).toHaveLength(3);
	});

	test("lista vazia não gera linha alguma", () => {
		expect(buildRows([], new Set())).toEqual([]);
	});
});

describe("descrição do que foi copiado", () => {
	test("corta e achata quebras de linha", () => {
		expect(describeCopy("uma\nlinha  só")).toBe("uma linha só");
		expect(describeCopy("x".repeat(80)).endsWith("…")).toBe(true);
		expect(describeCopy("x".repeat(80)).length).toBeLessThanOrEqual(46);
	});
});
