import { describe, expect, test } from "bun:test";
import { describeCopy } from "../src/core/clipboard";
import {
	parseDockerPs,
	parseLaunchdList,
	parsePm2List,
	parseSystemdUnits,
} from "../src/core/service/discover";
import { dispatch, type Region } from "../src/tui/mouse/MouseProvider";
import {
	ENABLE_MOUSE,
	isMouseInput,
	parseMouse,
	type TerminalMouseEvent,
} from "../src/tui/mouse/parse";

/**
 * Parsing do protocolo de mouse — a peça pura do clique. O resto (hit-testing
 * sobre a árvore do ink, e a regra de só a camada do topo receber o evento) é
 * verificado dirigindo a TUI num pty de verdade.
 *
 * A `árvore de configs` (`buildRows` do `ConfigTree`) saiu junto com a tela
 * inicial que a desenhava: o painel de serviços não agrupa yml por pasta, e um
 * teste exercitando componente que nada renderiza é manutenção sem cobertura.
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

	test("shift sai do bitfield sozinho, sem contaminar o botão", () => {
		// 0 + 4 (shift) — botão esquerdo COM shift continua sendo botão 0
		const event = parseMouse("\x1b[<4;5;5M").events[0];
		expect(event).toMatchObject({ kind: "press", button: 0, shift: true });
		expect(event?.ctrl).toBe(false);
		expect(event?.alt).toBe(false);

		// roda com shift: 64 + 4
		const wheel = parseMouse("\x1b[<68;5;5M").events[0];
		expect(wheel).toMatchObject({ kind: "wheel-up", shift: true });

		// sem shift o bit fica desligado
		expect(parseMouse("\x1b[<0;5;5M").events[0]?.shift).toBe(false);
	});

	test("liga o modo 1000 (clique+roda), nunca 1002/1003", () => {
		// Rastrear arrasto (1002) ou movimento (1003) tomaria do terminal o gesto
		// de selecionar texto — e o 1003 ainda satura o stdin.
		expect(ENABLE_MOUSE).toContain("[?1000h");
		expect(ENABLE_MOUSE).toContain("[?1006h");
		expect(ENABLE_MOUSE).not.toContain("1002");
		expect(ENABLE_MOUSE).not.toContain("1003");
	});

	test("reconhece a sequência como o ink a entrega (sem ESC)", () => {
		// Verificado na prática: o ink entrega o corpo do escape como "texto"
		expect(isMouseInput("[<0;10;5M")).toBe(true);
		expect(isMouseInput("\x1b[<0;10;5M")).toBe(true);
		expect(isMouseInput("j")).toBe(false);
		expect(isMouseInput("[<0;10;5")).toBe(false);
	});
});

describe("dispatch do mouse", () => {
	/**
	 * Área de clique falsa: o dispatch só pergunta ao yoga a posição/tamanho
	 * computados, então um stub com esses quatro números basta para exercitar o
	 * hit-testing sem montar a árvore do ink.
	 */
	function regionAt(rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): { region: Region; clicks: number[]; wheels: number[] } {
		const clicks: number[] = [];
		const wheels: number[] = [];
		const node = {
			yogaNode: {
				getComputedLeft: () => rect.x,
				getComputedTop: () => rect.y,
				getComputedWidth: () => rect.width,
				getComputedHeight: () => rect.height,
			},
			parentNode: null,
		};

		return {
			clicks,
			wheels,
			region: {
				id: 0,
				ref: { current: node } as unknown as Region["ref"],
				onClick: (info) => clicks.push(info.row),
				onWheel: (dir) => wheels.push(dir),
			},
		};
	}

	function event(over: Partial<TerminalMouseEvent> = {}): TerminalMouseEvent {
		return {
			kind: "press",
			x: 5,
			y: 5,
			button: 0,
			shift: false,
			alt: false,
			ctrl: false,
			...over,
		};
	}

	test("clique simples chega na área, com a linha relativa", () => {
		const { region, clicks } = regionAt({ x: 0, y: 3, width: 20, height: 10 });
		dispatch(new Map([[0, region]]), event({ x: 5, y: 5 }));
		expect(clicks).toEqual([2]);
	});

	test("shift+clique é ignorado: o arrasto pertence ao terminal", () => {
		// Terminal que NÃO faz o override nativo manda o press até aqui; se a TUI
		// reagisse, tentar selecionar texto abriria o menu do item.
		const { region, clicks } = regionAt({ x: 0, y: 0, width: 20, height: 10 });
		dispatch(new Map([[0, region]]), event({ shift: true }));
		expect(clicks).toEqual([]);
	});

	test("shift também neutraliza a roda", () => {
		const { region, wheels } = regionAt({ x: 0, y: 0, width: 20, height: 10 });
		dispatch(new Map([[0, region]]), event({ kind: "wheel-down" }));
		dispatch(
			new Map([[0, region]]),
			event({ kind: "wheel-down", shift: true }),
		);
		expect(wheels).toEqual([1]);
	});

	test("soltar não dispara ação (senão o clique contaria duas vezes)", () => {
		const { region, clicks } = regionAt({ x: 0, y: 0, width: 20, height: 10 });
		dispatch(new Map([[0, region]]), event({ kind: "release" }));
		expect(clicks).toEqual([]);
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
