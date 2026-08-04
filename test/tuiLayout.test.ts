import { describe, expect, test } from "bun:test";
import {
	ASIDE_WIDTH,
	CHROME_ROWS,
	fitHints,
	layout,
	RAIL_WIDTH,
	shortenPath,
	tabAt,
	tabCells,
} from "../src/tui/layout";

/**
 * Geometria do cockpit DEPOIS que a sidebar virou aba no topo.
 *
 * O ponto que estes testes protegem: nenhuma coluna some no caminho. A conta
 * antiga reservava a sidebar em toda tela — inclusive nas que não tinham menu
 * — e era ela que cortava os caminhos das configs no meio.
 */

describe("layout do cockpit", () => {
	test("sem trilho, o centro fica com tudo o que não é painel de contexto", () => {
		const l = layout(120, 38);
		expect(l.rail).toBe(0);
		expect(l.aside).toBe(ASIDE_WIDTH);
		expect(l.center).toBe(120 - ASIDE_WIDTH);
		expect(l.narrow).toBe(false);
	});

	test("com trilho, as três colunas somam a largura da tela", () => {
		const l = layout(120, 38, RAIL_WIDTH);
		expect(l.rail).toBe(RAIL_WIDTH);
		expect(l.rail + l.center + l.aside).toBe(120);
	});

	test("a lista ganhou a largura que a sidebar cobrava", () => {
		// 19 era a sidebar antiga, presente em TODA tela
		expect(layout(120, 38).center).toBe(layout(120, 38, 19).center + 19);
	});

	test("terminal estreito sacrifica o painel de contexto, não a lista", () => {
		const l = layout(80, 30);
		expect(l.aside).toBe(0);
		expect(l.narrow).toBe(true);
		expect(l.center).toBe(80);
		expect(l.center).toBeGreaterThan(40);
	});

	test("trilho cede quando não sobra centro utilizável", () => {
		const l = layout(36, 30, RAIL_WIDTH);
		expect(l.rail).toBeLessThanOrEqual(RAIL_WIDTH);
		expect(l.center).toBeGreaterThanOrEqual(20);
		expect(l.rail + l.center).toBeLessThanOrEqual(36);
	});

	test("altura desconta cabeçalho, abas, aviso e barra de teclas", () => {
		const l = layout(120, 38);
		expect(l.body).toBe(38 - CHROME_ROWS);
		expect(l.panelRows).toBeLessThan(l.body);
	});

	/**
	 * Guarda contra o bug medido na integração: com a barra de teclas em DUAS
	 * linhas, o chrome passou a somar exatamente a altura do terminal e o yoga
	 * espremeu a faixa de abas — os rótulos sumiram e sobrou a régua. O reservado
	 * tem de ser maior que o desenhado, com pelo menos uma linha de folga.
	 */
	test("reserva de chrome cobre o que o Shell desenha, com folga", () => {
		const cabecalho = 3;
		const abas = 2; // rótulos + régua
		const aviso = 1;
		const teclas = 2;
		const desenhado = cabecalho + abas + aviso + teclas;

		expect(CHROME_ROWS).toBeGreaterThan(desenhado);
		expect(CHROME_ROWS - desenhado).toBe(1);
	});

	test("janela minúscula não gera largura ou altura negativa", () => {
		const l = layout(20, 4, RAIL_WIDTH);
		expect(l.center).toBeGreaterThan(0);
		expect(l.rail).toBeGreaterThanOrEqual(0);
		expect(l.body).toBeGreaterThan(0);
		expect(l.panelRows).toBeGreaterThan(0);
	});
});

describe("faixa de abas", () => {
	const labels = ["configs", "rodando", "logs", "serviço"];

	test("as células são consecutivas e não se sobrepõem", () => {
		const cells = tabCells(labels);
		expect(cells[0]?.start).toBe(0);
		for (let i = 1; i < cells.length; i++) {
			const prev = cells[i - 1];
			const cur = cells[i];
			if (!prev || !cur) throw new Error("célula ausente");
			expect(cur.start).toBe(prev.start + prev.width);
		}
	});

	test("clique por coluna acha a aba certa", () => {
		const cells = tabCells(labels);
		expect(tabAt(cells, 0)).toBe(0);
		expect(tabAt(cells, (cells[1]?.start ?? 0) + 1)).toBe(1);
		expect(tabAt(cells, (cells[3]?.start ?? 0) + 2)).toBe(3);
	});

	test("clique fora da faixa não seleciona nada", () => {
		const cells = tabCells(labels);
		const end = cells.reduce((sum, c) => sum + c.width, 0);
		expect(tabAt(cells, end)).toBe(-1);
		expect(tabAt(cells, -1)).toBe(-1);
	});
});

describe("encurtar caminho", () => {
	test("caminho que cabe volta inteiro", () => {
		expect(shortenPath("pulsar/configs/ads.yml", 40)).toBe(
			"pulsar/configs/ads.yml",
		);
	});

	test("some o MEIO, nunca o nome do arquivo", () => {
		const short = shortenPath("pulsar/infra/configs/ads-staging.yml", 26);
		expect(short).toContain("ads-staging.yml");
		expect(short.length).toBeLessThanOrEqual(26);
		expect(short).toBe("pulsar/…/ads-staging.yml");
	});

	test("sem espaço nem para a primeira pasta, resta o arquivo", () => {
		const short = shortenPath("um/dois/tres/ads-staging.yml", 18);
		expect(short).toBe("…/ads-staging.yml");
	});

	test("nome que cabe sozinho perde o caminho, mas não ganha reticências", () => {
		expect(shortenPath("docs/demo/limpeza-ttl.yml", 16)).toBe(
			"limpeza-ttl.yml",
		);
	});

	test("nome maior que a coluna é cortado no fim, e só aí", () => {
		expect(shortenPath("a/nome-muito-comprido.yml", 10)).toBe("nome-muit…");
	});
});

describe("fitHints", () => {
	const SAIR = { keys: "ctrl+d", label: "sair da TUI" };
	const ABAS = { keys: "1-4", label: "abas" };
	const TELA = [
		{ keys: "↑↓", label: "navegar" },
		{ keys: "enter", label: "ações do arquivo" },
		{ keys: "←→", label: "fechar/abrir seção" },
		{ keys: "n", label: "nova config" },
		{ keys: "r", label: "rodar" },
		{ keys: "b", label: "subir em background" },
		{ keys: "l", label: "logs" },
		{ keys: "ctrl+c", label: "copiar caminho" },
		{ keys: "m", label: "mouse on/off" },
	];

	test("mantém a saída mesmo quando as teclas da tela não cabem", () => {
		// 140x2 era exatamente o caso em que `ctrl+d sair da TUI` sumia da tela.
		const fit = fitHints([ABAS], TELA, [SAIR], 140, 2);
		expect(fit.at(-1)).toEqual(SAIR);
		expect(fit[0]).toEqual(ABAS);
	});

	test("o que sobra cabe no orçamento de colunas × linhas", () => {
		for (const columns of [80, 96, 100, 140, 200]) {
			const fit = fitHints([ABAS], TELA, [SAIR], columns, 2);
			const largura =
				fit.reduce((s, h) => s + h.keys.length + 1 + h.label.length, 0) +
				(fit.length - 1) * 3;
			expect(largura).toBeLessThanOrEqual(columns * 2);
		}
	});

	test("descarta a partir do FIM da lista da tela, preservando a ordem", () => {
		const fit = fitHints([], TELA, [SAIR], 60, 2);
		const daTela = fit.filter((h) => h !== SAIR);
		expect(daTela).toEqual(TELA.slice(0, daTela.length));
	});

	test("terminal absurdamente estreito ainda anuncia a saída", () => {
		// A saída é a ÚNICA garantia: ela nunca é a que cai fora, por mais
		// apertada que a janela esteja.
		for (const columns of [20, 30, 40]) {
			const fit = fitHints([ABAS], TELA, [SAIR], columns, 2);
			expect(fit).toContainEqual(SAIR);
		}
	});

	test("cabendo tudo, nada é descartado", () => {
		const fit = fitHints([ABAS], TELA, [SAIR], 400, 2);
		expect(fit).toHaveLength(TELA.length + 2);
	});
});
