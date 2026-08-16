/**
 * Protocolo de mouse do terminal (SGR 1006) — parsing puro, sem React.
 *
 * O terminal reporta cliques como sequências `ESC [ < botão ; coluna ; linha M|m`
 * (M = pressionou, m = soltou). O modo SGR é o único que funciona além da coluna
 * 223: o modo antigo codifica a posição em UM byte, e a partir daí os cliques
 * chegam com coordenadas erradas — inútil num cockpit de 120 colunas.
 *
 * Coordenadas do terminal são 1-based; aqui saem 0-based, que é como o layout
 * do ink conta.
 *
 * MODO DE RASTREAMENTO — o menos invasivo que atende o cockpit. A TUI só
 * precisa de clique e roda, então fica no 1000 (normal tracking: press,
 * release e roda). NÃO usamos 1002 (button-event) porque ele passa a reportar
 * o ARRASTO — justamente o gesto que o terminal precisa manter para o usuário
 * selecionar texto —, e muito menos 1003 (any-event), que reporta movimento
 * SEM botão nenhum: o stdin recebe um evento por célula percorrida, satura o
 * loop de eventos do ink e é o que mais atrapalha o terminal.
 *
 * Consequência prática de ficar no 1000: como o terminal jamais nos manda
 * movimento, um arrasto chega no máximo como um press e um release soltos —
 * quem desenha (ou não) a seleção é o terminal. Ver o tratamento de SHIFT no
 * dispatch do MouseProvider.
 */

export type MouseEventKind = "press" | "release" | "wheel-up" | "wheel-down";

export type TerminalMouseEvent = {
	kind: MouseEventKind;
	/** coluna 0-based */
	x: number;
	/** linha 0-based */
	y: number;
	button: number;
	/** bit 2 (valor 4) do byte de botão — a tecla que devolve a seleção nativa */
	shift: boolean;
	/** bit 3 (valor 8) — "meta"/alt */
	alt: boolean;
	/** bit 4 (valor 16) */
	ctrl: boolean;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC é o caractere que inicia a sequência
const SGR = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Reconhece a sequência de mouse JÁ processada pelo ink, que entrega o corpo do
 * escape como se fosse texto digitado (`[<0;10;5M`).
 *
 * Sem esta guarda, clicar com o campo de busca ativo digitaria "[<0;10;5M"
 * dentro dele — verificado na prática antes de escrever este módulo.
 */
export function isMouseInput(input: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: idem
	return /^\x1b?\[<\d+;\d+;\d+[Mm]$/.test(input);
}

/**
 * Extrai os eventos de um pedaço do stdin. Devolve também o resto não
 * consumido: uma sequência pode chegar partida entre dois chunks.
 */
export function parseMouse(chunk: string): {
	events: TerminalMouseEvent[];
	rest: string;
} {
	const events: TerminalMouseEvent[] = [];
	let lastEnd = 0;

	SGR.lastIndex = 0;
	let match = SGR.exec(chunk);
	while (match) {
		const [full, rawButton, rawX, rawY, action] = match;
		const button = Number(rawButton);

		events.push({
			kind: kindOf(button, action === "M"),
			// -1: o terminal conta a partir de 1
			x: Number(rawX) - 1,
			y: Number(rawY) - 1,
			button: button & 0b11,
			// Modificadores vivem nos bits altos do MESMO byte do botão; por isso
			// o botão precisa ser mascarado (0b11) antes de ser comparado.
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
		});

		lastEnd = match.index + full.length;
		match = SGR.exec(chunk);
	}

	// Guarda só uma cauda plausível de sequência incompleta; qualquer outra
	// coisa é descartada para o buffer não crescer indefinidamente.
	const tail = chunk.slice(lastEnd);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: idem
	const rest = /\x1b?\[?<?[\d;]*$/.test(tail) ? tail.slice(-32) : "";

	return { events, rest };
}

function kindOf(button: number, pressed: boolean): MouseEventKind {
	// 64/65: roda do mouse (o bit 64 marca "wheel"; o de baixo, a direção)
	if (button & 64) return (button & 1) === 0 ? "wheel-up" : "wheel-down";
	return pressed ? "press" : "release";
}

/**
 * Liga o rastreamento de cliques + o modo SGR.
 *
 * As sequências vivem em `core/tty/ansi.ts` (dali `withTerminal` também
 * precisa delas para soltar/devolver o terminal ao sudo) — aqui é só
 * reexportação, para não haver duas verdades sobre a mesma sequência.
 */
export { DISABLE_MOUSE, ENABLE_MOUSE } from "../../core/tty/ansi";
