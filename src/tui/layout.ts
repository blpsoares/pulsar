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
 *
 * O piso de 6 linhas da altura NUNCA é alcançado na prática: o `App` nem
 * desenha overlay abaixo de `MIN_ROWS` (= 20, em `hooks/useTerminalSize.ts`),
 * e 80% de 20 já dá 16. Ele fica como rede — mas o acoplamento entre os dois
 * arquivos é implícito, então: se `MIN_ROWS` cair para menos de 8, revise este
 * piso e o que o overlay desenha nessa altura, porque aí ele passa a valer.
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

export type Window = { start: number; end: number };

/**
 * Fatia visível de uma lista cujo CURSOR deve permanecer sempre à vista.
 *
 * Diferente do `scrollWindow` de tela de log (que ancora no FIM do conteúdo,
 * como um `tail -f`), esta janela SEGUE o cursor: sobe quando ele sai por
 * cima, desce quando ele sai por baixo, e não se move enquanto ele segue
 * dentro dela — é o que evita a janela "pular" a cada tecla de navegação.
 *
 * Existe porque o `Box` do ink 7 não recorta o próprio conteúdo (não há
 * `overflow: hidden` que funcione): desenhar mais linhas do que cabem no
 * terminal não corta a saída, CORROMPE o frame — o ink não consegue subir o
 * cursor o bastante para apagar o quadro anterior. Numa lista maior que a
 * tela, é obrigatório recortar os dados ANTES de renderizar.
 */
export function listWindow(
	total: number,
	height: number,
	cursor: number,
): Window {
	if (total <= 0) return { start: 0, end: 0 };
	// Altura zero/negativa (terminal minúsculo) não pode virar janela invertida.
	const size = Math.max(0, Math.min(height, total));
	if (size <= 0) return { start: 0, end: 0 };

	// Cursor fora dos limites (lista mudou de tamanho sob o pé do usuário) é
	// grampeado antes de decidir a janela — senão `start`/`end` saem do range.
	const at = Math.max(0, Math.min(total - 1, cursor));

	// Centraliza o cursor na janela quando há folga dos dois lados; perto das
	// pontas, o `clamp` a seguir gruda a janela no começo/fim da lista em vez
	// de deixar espaço vazio sobrando.
	const centered = at - Math.floor((size - 1) / 2);
	const start = Math.max(0, Math.min(total - size, centered));

	return { start, end: start + size };
}

/**
 * Encurta um caminho preservando o NOME DO ARQUIVO.
 *
 * O nome é o que identifica a config; cortar `ads-staging.yml` em `ads-s…`
 * (que era o que a sidebar de 19 colunas fazia) transforma a lista em
 * adivinhação. Quando não cabe, some o MEIO do caminho — `pulsar/…/ads.yml` —
 * porque a pasta raiz e o arquivo são o que orientam.
 */
export function shortenPath(path: string, max: number): string {
	if (max <= 1) return path.slice(0, Math.max(0, max));
	if (path.length <= max) return path;

	const parts = path.split("/");
	const file = parts[parts.length - 1] ?? path;
	const head = parts[0] ?? "";

	if (parts.length > 2) {
		const withHead = `${head}/…/${file}`;
		if (withHead.length <= max) return withHead;
	}

	const tail = `…/${file}`;
	if (parts.length > 1 && tail.length <= max) return tail;

	// O nome sozinho cabe: some com o caminho inteiro, sem reticências — elas
	// dariam a impressão de que o NOME foi cortado, que é a leitura errada.
	if (file.length <= max) return file;

	// Nem o nome do arquivo cabe: corta o FIM dele (a extensão importa menos
	// que o começo, que é onde mora a diferença entre um yml e outro).
	return `${file.slice(0, max - 1)}…`;
}

export type HintLike = { keys: string; label: string };

/**
 * Escolhe quais teclas cabem na barra, com as OBRIGATÓRIAS garantidas.
 *
 * A barra tem altura fixa (reservada no CHROME_ROWS) e o texto quebra por
 * palavra. Quando a lista passa das linhas disponíveis, o excedente não é
 * "cortado com reticências": ele some sem deixar rastro, porque o Box recorta
 * a terceira linha inteira. Foi o que aconteceu com `ctrl+d sair da TUI` na
 * tela inicial a 140 colunas — o único jeito anunciado de sair da TUI
 * desapareceu justamente na tela onde mais falta.
 *
 * Por isso o orçamento é calculado ANTES de renderizar: as teclas obrigatórias
 * (sair, seleção de texto) reservam seu espaço primeiro, e as teclas da
 * TELA ocupam o que sobrou, na ordem em que a tela as listou — as últimas caem
 * fora, que é o comportamento certo, porque cada tela lista da mais para a
 * menos usada.
 */
export function fitHints(
	leading: HintLike[],
	screen: HintLike[],
	trailing: HintLike[],
	columns: number,
	rows: number,
): HintLike[] {
	// " · " entre itens, "keys label" dentro de cada um.
	const cost = (h: HintLike) => h.keys.length + 1 + h.label.length;
	const SEP = 3;

	const budget = Math.max(0, columns * rows);
	const fixed = [...leading, ...trailing];
	// -1 por linha: quebrar por palavra raramente preenche a coluna final.
	let used =
		fixed.reduce((sum, h) => sum + cost(h), 0) +
		Math.max(0, fixed.length - 1) * SEP +
		rows;

	const kept: HintLike[] = [];
	for (const h of screen) {
		const next = used + cost(h) + SEP;
		if (next > budget) break;
		used = next;
		kept.push(h);
	}

	return [...leading, ...kept, ...trailing];
}
