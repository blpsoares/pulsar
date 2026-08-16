import { describe, expect, test } from "bun:test";
import { CHROME_ROWS, fitHints, shortenPath } from "../src/tui/layout";

/**
 * Geometria pura que sobreviveu à integração do painel único.
 *
 * A parte de ABAS destes testes saiu junto com as abas (o desenho vigente é o
 * painel único de serviços); o que ficou é o que continua valendo: a reserva
 * de altura do chrome, o encurtamento de caminho e o orçamento da barra de
 * teclas — o bug de `ctrl+d sair da TUI` sumindo a 140 colunas.
 */

describe("altura do chrome", () => {
	/**
	 * O reservado tem de ser maior que o desenhado, com uma linha de folga:
	 * quando os dois empatam, o yoga espreme a última faixa e ela some da tela.
	 */
	test("reserva de chrome cobre o que o Shell desenha, com folga", () => {
		const cabecalho = 3;
		const aviso = 1;
		const teclas = 1;
		const desenhado = cabecalho + aviso + teclas;

		expect(CHROME_ROWS).toBeGreaterThan(desenhado);
		expect(CHROME_ROWS - desenhado).toBe(1);
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
	const MOUSE = { keys: "shift+arrastar", label: "selecionar texto" };
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
		// 140 colunas era exatamente o caso em que `ctrl+d sair da TUI` sumia.
		const fit = fitHints([MOUSE], TELA, [SAIR], 140, 2);
		expect(fit.at(-1)).toEqual(SAIR);
		expect(fit[0]).toEqual(MOUSE);
	});

	test("o que sobra cabe no orçamento de colunas × linhas", () => {
		for (const columns of [80, 96, 100, 140, 200]) {
			const fit = fitHints([MOUSE], TELA, [SAIR], columns, 2);
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
			const fit = fitHints([MOUSE], TELA, [SAIR], columns, 2);
			expect(fit).toContainEqual(SAIR);
		}
	});

	test("cabendo tudo, nada é descartado", () => {
		const fit = fitHints([MOUSE], TELA, [SAIR], 400, 2);
		expect(fit).toHaveLength(TELA.length + 2);
	});
});
