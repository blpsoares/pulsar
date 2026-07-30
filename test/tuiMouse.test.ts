import { describe, expect, test } from "bun:test";
import { describeCopy } from "../src/core/clipboard";
import {
	parseDockerPs,
	parseLaunchdList,
	parsePm2List,
	parseSystemdUnits,
} from "../src/core/service/discover";
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
			rows.some(
				(r) => r.kind === "item" && r.config.file.startsWith("configs/"),
			),
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

describe("descoberta de serviços", () => {
	test("systemd: lê nome e estado, ignorando o que não é do pulsar", () => {
		const stdout = [
			"pulsar-ads.service        loaded active   running pulsar sync (ads)",
			"● pulsar-velho.service    loaded failed   dead    pulsar sync (velho)",
			"outra-coisa.service       loaded active   running nada a ver",
		].join("\n");

		const found = parseSystemdUnits(stdout);
		expect(found.map((s) => s.name)).toEqual(["pulsar-ads", "pulsar-velho"]);
		expect(found[0]?.running).toBe(true);
		expect(found[1]?.running).toBe(false);
		expect(found[0]?.backend).toBe("systemd");
	});

	test("systemd: cabeçalho e linhas vazias não viram serviço", () => {
		expect(parseSystemdUnits("UNIT LOAD ACTIVE SUB DESCRIPTION\n\n")).toEqual(
			[],
		);
	});

	test("pm2: só apps com prefixo pulsar-, online = no ar", () => {
		const stdout = JSON.stringify([
			{ name: "pulsar-x", pm2_env: { status: "online", autorestart: true } },
			{ name: "pulsar-y", pm2_env: { status: "stopped", autorestart: false } },
			{ name: "outro-app", pm2_env: { status: "online" } },
		]);

		const found = parsePm2List(stdout);
		expect(found).toHaveLength(2);
		expect(found[0]).toMatchObject({
			name: "pulsar-x",
			running: true,
			enabled: true,
		});
		expect(found[1]).toMatchObject({
			name: "pulsar-y",
			running: false,
			enabled: false,
		});
	});

	test("pm2: saída inválida não derruba a varredura", () => {
		expect(parsePm2List("não é json")).toEqual([]);
	});

	test("docker: 'Up ...' é no ar; política de restart marca o boot", () => {
		const stdout = [
			"pulsar-sync-a\tUp 3 hours\tunless-stopped",
			"pulsar-sync-b\tExited (0) 2 days ago\tno",
			"outro\tUp 1 hour\talways",
		].join("\n");

		const found = parseDockerPs(stdout);
		expect(found).toHaveLength(2);
		expect(found[0]).toMatchObject({ running: true, enabled: true });
		expect(found[1]).toMatchObject({ running: false, enabled: false });
	});

	test("launchd: PID '-' significa carregado mas parado", () => {
		const stdout = [
			"PID\tStatus\tLabel",
			"1234\t0\tcom.pulsar.ads",
			"-\t0\tcom.pulsar.parado",
			"999\t0\tcom.apple.outra",
		].join("\n");

		const found = parseLaunchdList(stdout);
		expect(found.map((s) => s.name)).toEqual([
			"com.pulsar.ads",
			"com.pulsar.parado",
		]);
		expect(found[0]?.running).toBe(true);
		expect(found[1]?.running).toBe(false);
	});
});
