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
 */

export type MouseEventKind = "press" | "release" | "wheel-up" | "wheel-down";

export type TerminalMouseEvent = {
	kind: MouseEventKind;
	/** coluna 0-based */
	x: number;
	/** linha 0-based */
	y: number;
	button: number;
	shift: boolean;
	alt: boolean;
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

/** Liga o rastreamento de cliques + o modo SGR. */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
