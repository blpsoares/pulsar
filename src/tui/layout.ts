/**
 * Geometria do cockpit — matemática pura, sem React.
 *
 * Fica fora do Shell.tsx para poder ser testada sem montar componente: é a
 * conta que decide se a lista de collections tem espaço para respirar ou se o
 * painel de contexto precisa sair de cena.
 */

export const SIDEBAR_WIDTH = 19;
export const ASIDE_WIDTH = 24;
/** cabeçalho (3) + barra de teclas (1) + margem (1) */
export const CHROME_ROWS = 5;

export type Layout = {
	sidebar: number;
	center: number;
	aside: number;
	/** altura útil dos painéis (tela menos cabeçalho e barra de teclas) */
	body: number;
	/** linhas disponíveis dentro de um painel (menos borda e título) */
	panelRows: number;
	/** true quando não cabe painel de contexto à direita */
	narrow: boolean;
};

/**
 * Divide a tela entre sidebar, centro e painel de contexto.
 *
 * Abaixo de 96 colunas o painel da direita é sacrificado antes de tudo: é
 * contexto, não conteúdo. Espremer três painéis num terminal estreito deixaria
 * a lista de collections com uma dúzia de caracteres, que é pior do que não ter
 * o resumo à vista.
 */
export function layout(
	columns: number,
	rows: number,
	/**
	 * A barra de teclas ganha uma linha quando há aviso. Sem descontá-la aqui, os
	 * painéis (que têm altura FIXA) passam da altura da tela e o ink quebra a
	 * moldura na última linha.
	 */
	hasNotice = false,
): Layout {
	const narrow = columns < 96;
	const aside = narrow ? 0 : ASIDE_WIDTH;
	const center = Math.max(20, columns - SIDEBAR_WIDTH - aside);
	const body = Math.max(6, rows - CHROME_ROWS - (hasNotice ? 1 : 0));

	return {
		sidebar: SIDEBAR_WIDTH,
		center,
		aside,
		body,
		panelRows: Math.max(3, body - 3),
		narrow,
	};
}
