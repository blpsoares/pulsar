/**
 * Geometria do cockpit — matemática pura, sem React.
 *
 * Fica fora do Shell.tsx para poder ser testada sem montar componente: é a
 * conta que decide se a lista de collections tem espaço para respirar ou se o
 * painel de contexto precisa sair de cena.
 */

export const SIDEBAR_WIDTH = 19;
export const ASIDE_WIDTH = 24;
/**
 * cabeçalho (3) + linha de aviso (1) + barra de teclas (1) + margem (1).
 *
 * A linha de aviso é reservada SEMPRE, mesmo vazia. Calcular a altura conforme
 * exista ou não aviso parece econômico e cria um bug inteiro: um aviso que
 * aparece depois (o "copiado" do Ctrl+C, por exemplo) empurraria os painéis —
 * que têm altura fixa — para fora da tela, e a mensagem simplesmente não seria
 * vista. Uma linha a menos vale a geometria constante.
 */
export const CHROME_ROWS = 6;

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
export function layout(columns: number, rows: number): Layout {
	const narrow = columns < 96;
	const aside = narrow ? 0 : ASIDE_WIDTH;
	const center = Math.max(20, columns - SIDEBAR_WIDTH - aside);
	const body = Math.max(6, rows - CHROME_ROWS);

	return {
		sidebar: SIDEBAR_WIDTH,
		center,
		aside,
		body,
		panelRows: Math.max(3, body - 3),
		narrow,
	};
}

/** Abaixo disto, moldura centralizada deixaria conteúdo ilegível. */
const OVERLAY_MIN_COLUMNS = 60;
/** Fração da tela que o overlay ocupa quando há espaço de sobra. */
const OVERLAY_RATIO = 0.8;

export type OverlayBox = {
	width: number;
	height: number;
	marginLeft: number;
	marginTop: number;
};

/**
 * Geometria da caixa flutuante.
 *
 * Separada do componente pela mesma razão que `layout()`: é a conta que decide
 * se o formulário respira ou não, e testá-la exige zero React.
 */
export function overlayBox(columns: number, rows: number): OverlayBox {
	const full = columns < OVERLAY_MIN_COLUMNS;
	const width = full ? columns : Math.round(columns * OVERLAY_RATIO);
	const height = Math.max(6, Math.min(rows, Math.round(rows * OVERLAY_RATIO)));

	return {
		width,
		height,
		marginLeft: Math.floor((columns - width) / 2),
		marginTop: Math.floor((rows - height) / 2),
	};
}
