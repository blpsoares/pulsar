/**
 * Geometria do cockpit — matemática pura, sem React.
 *
 * Fica fora do Shell.tsx para poder ser testada sem montar componente: é a
 * conta que decide se a lista de configs tem espaço para respirar ou se o
 * painel de contexto precisa sair de cena.
 */

export const ASIDE_WIDTH = 24;
/**
 * Trilho auxiliar à esquerda (passos do wizard, fontes de log, opções do
 * runner). NÃO é mais a navegação da TUI — essa subiu para as abas do topo.
 *
 * 22 e não 19 como a antiga sidebar: com 19 colunas, tirando borda e padding
 * sobravam 15 caracteres e todo rótulo terminava em "…". Um trilho que não dá
 * para ler não é navegação, é enfeite.
 */
export const RAIL_WIDTH = 22;
/** Abaixo disto o painel central deixa de ser utilizável. */
export const MIN_CENTER = 20;
/**
 * cabeçalho (3) + abas (1) + régua das abas (1) + linha de aviso (1) +
 * barra de teclas (2) + margem (1).
 *
 * A barra de teclas ocupa DUAS linhas de propósito: a lista de atalhos de uma
 * tela cheia (tela inicial: abas + nove teclas + seleção de texto + saída) não
 * cabe em 140 colunas, e truncá-la escondia sempre as MESMAS teclas do fim
 * (mouse, sair). Duas linhas com quebra por palavra mostram tudo sem custar
 * geometria variável — a altura é a mesma haja ou não segunda linha.
 *
 * A margem de 1 linha NÃO é enfeite: sem ela o conteúdo bate exatamente na
 * altura do terminal e o yoga espreme o primeiro item flexível que encontra —
 * medido, a faixa de abas rendeu uma linha EM BRANCO (rótulos sumidos, régua
 * intacta) quando a soma fechava 40 em 40 linhas. Reservar uma linha a mais
 * custa uma linha de painel e evita perder a navegação inteira.
 *
 * A linha de aviso é reservada SEMPRE, mesmo vazia. Calcular a altura conforme
 * exista ou não aviso parece econômico e cria um bug inteiro: um aviso que
 * aparece depois (o "copiado" do Ctrl+C, por exemplo) empurraria os painéis —
 * que têm altura fixa — para fora da tela, e a mensagem simplesmente não seria
 * vista. Uma linha a menos vale a geometria constante. Vale igual para as
 * abas: elas são desenhadas em TODA tela, inclusive nas sub-telas, justamente
 * para a altura não mudar quando se entra no wizard.
 */
export const CHROME_ROWS = 9;

export type Layout = {
	/** trilho da esquerda; 0 quando a tela não pediu um (ou não coube) */
	rail: number;
	center: number;
	aside: number;
	/** altura útil dos painéis (tela menos cabeçalho, abas e barra de teclas) */
	body: number;
	/** linhas disponíveis dentro de um painel (menos borda e título) */
	panelRows: number;
	/** true quando não cabe painel de contexto à direita */
	narrow: boolean;
};

/**
 * Divide a tela entre trilho (opcional), centro e painel de contexto.
 *
 * A navegação global saiu da esquerda e virou aba no topo — por isso o padrão
 * é NÃO reservar nada à esquerda: a largura que a sidebar comia vai inteira
 * para o conteúdo, que é onde os caminhos de arquivo estavam sendo cortados.
 * Só quem tem um trilho de verdade (wizard, logs, services, runner) pede o
 * `rail`, e ainda assim ele cede se não sobrar centro utilizável.
 *
 * Abaixo de 96 colunas o painel da direita é sacrificado antes de tudo: é
 * contexto, não conteúdo.
 */
export function layout(columns: number, rows: number, rail = 0): Layout {
	const narrow = columns < 96;
	const aside = narrow ? 0 : ASIDE_WIDTH;
	const railWidth =
		rail > 0 ? Math.max(0, Math.min(rail, columns - aside - MIN_CENTER)) : 0;
	const center = Math.max(MIN_CENTER, columns - railWidth - aside);
	const body = Math.max(6, rows - CHROME_ROWS);

	return {
		rail: railWidth,
		center,
		aside,
		body,
		panelRows: Math.max(3, body - 3),
		narrow,
	};
}

// ------------------------------------------------------------------- abas

export type TabCell = { start: number; width: number };

/**
 * Posição de cada aba na faixa horizontal.
 *
 * Existe separado do componente porque o clique precisa da MESMA conta: o
 * hit-testing do mouse entrega uma coluna, e é aqui que ela vira aba. Duas
 * contas paralelas (uma para desenhar, outra para clicar) sairiam do lugar na
 * primeira vez que alguém mexesse no espaçamento.
 *
 * Formato de cada célula: `" N rótulo  "` — número do atalho, rótulo, respiro.
 */
export function tabCells(labels: readonly string[]): TabCell[] {
	let start = 0;
	return labels.map((label) => {
		const width = label.length + 5;
		const cell = { start, width };
		start += width;
		return cell;
	});
}

/** Índice da aba sob a coluna, ou -1 fora de qualquer uma. */
export function tabAt(cells: readonly TabCell[], column: number): number {
	return cells.findIndex(
		(cell) => column >= cell.start && column < cell.start + cell.width,
	);
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
 * (sair, seleção de texto, abas) reservam seu espaço primeiro, e as teclas da
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
