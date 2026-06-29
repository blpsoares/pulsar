import { describe, expect, test } from "bun:test";
import { renderClosingPanel } from "../src/utils/progressManager";

const base = {
	total: 50,
	resumed: 50,
	dumped: 0,
	dumpedNames: [] as string[],
	failed: [] as string[],
	docsDumped: 0,
	durationMs: 33000,
	stopHint: "parar: docker stop (salva o checkpoint, não remova)",
};

describe("renderClosingPanel — largura dinâmica", () => {
	test("linha de índices com várias collections não trunca os nomes", () => {
		const panel = renderClosingPanel({
			...base,
			indexes: {
				created: 0,
				skipped: 76,
				failed: [
					{ coll: "_sep_campanhas", name: "a" },
					{ coll: "_sep_pis", name: "b" },
					{ coll: "_sep_propostas", name: "c" },
					{ coll: "_sep_pis_predios", name: "d" },
				],
			},
		});
		for (const c of [
			"_sep_campanhas",
			"_sep_pis",
			"_sep_propostas",
			"_sep_pis_predios",
		]) {
			expect(panel).toContain(c);
		}
		expect(panel).not.toContain("…"); // nada cortado
	});

	test("a caixa é retangular (todas as linhas com a mesma largura)", () => {
		const panel = renderClosingPanel({
			...base,
			indexes: {
				created: 0,
				skipped: 76,
				failed: [{ coll: "_sep_campanhas", name: "a" }],
			},
		});
		const widths = new Set(panel.split("\n").map((l) => [...l].length));
		expect(widths.size).toBe(1);
	});

	test("painel curto mantém a largura mínima legível", () => {
		const panel = renderClosingPanel(base);
		const w = [...(panel.split("\n")[0] ?? "")].length;
		expect(w).toBeGreaterThanOrEqual(56); // 54 (mín. interno) + 2 bordas
	});

	test("conteúdo absurdamente longo é truncado no teto (caixa não explode)", () => {
		const many = Array.from({ length: 60 }, (_, i) => ({
			coll: `collection_com_nome_longo_${i}`,
			name: "x",
		}));
		const panel = renderClosingPanel({
			...base,
			indexes: { created: 0, skipped: 0, failed: many },
		});
		const w = [...(panel.split("\n")[0] ?? "")].length;
		expect(w).toBeLessThanOrEqual(122); // teto 120 + 2 bordas
	});
});
