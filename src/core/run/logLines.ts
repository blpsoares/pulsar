/**
 * Normalização da saída de um processo filho para caber numa TUI.
 *
 * O pulsar escreve com chalk, barras de progresso e `\r`. Jogar isso cru
 * dentro de um componente do ink destrói o layout: os escapes de cor
 * confundem a contagem de largura e o `\r` faz o ink desenhar linhas em cima
 * das outras. Aqui a saída vira uma lista de linhas limpas.
 *
 * Detalhe importante: o filho roda SEM TTY (stdout é um pipe), então o próprio
 * pulsar já desliga as barras e passa a imprimir o bloco STATUS a cada N
 * segundos (`utils/progressManager.ts`). Ou seja, o que chega aqui já é o
 * formato certo para leitura — este módulo só faz a faxina final.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: sequências ANSI são caracteres de controle por definição
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/**
 * Buffer circular de linhas. Um `sync` verboso produz linhas indefinidamente —
 * sem teto, a TUI acumularia memória até o fim do processo.
 */
export class LineBuffer {
	private lines: string[] = [];
	private partial = "";

	constructor(private readonly max = 500) {}

	/** Recebe um pedaço arbitrário do stream (pode cortar no meio de uma linha). */
	push(chunk: string): void {
		const text = stripAnsi(this.partial + chunk).replace(/\r(?!\n)/g, "\n");
		const parts = text.split("\n");
		// A última fatia pode ser uma linha incompleta: guarda para o próximo chunk.
		this.partial = parts.pop() ?? "";

		for (const line of parts) {
			const trimmed = line.trimEnd();
			// Linhas vazias em sequência viram uma só: o STATUS do pulsar usa
			// espaçamento generoso que ocuparia a tela inteira aqui.
			if (!trimmed && this.lines.at(-1) === "") continue;
			this.lines.push(trimmed);
		}

		if (this.lines.length > this.max) this.lines = this.lines.slice(-this.max);
	}

	/** Fecha a linha pendente (chamado quando o stream termina). */
	flush(): void {
		if (!this.partial) return;
		this.lines.push(stripAnsi(this.partial).trimEnd());
		this.partial = "";
	}

	all(): string[] {
		return this.partial ? [...this.lines, this.partial] : [...this.lines];
	}

	/** Últimas N linhas — o que a tela realmente desenha. */
	tail(n: number): string[] {
		return this.all().slice(-n);
	}

	clear(): void {
		this.lines = [];
		this.partial = "";
	}
}

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Classifica a linha por nível para colorir. Heurística sobre o texto porque a
 * saída do terminal do pulsar não é estruturada — o JSON estruturado existe
 * nos arquivos de log, que têm leitor próprio.
 */
export function levelOf(line: string): LogLevel {
	if (/\[\s*ERROR\s*\]|✖|error|falh|fail/i.test(line)) return "error";
	if (/\[\s*WARN\s*\]|⚠|warn|aviso/i.test(line)) return "warn";
	if (/\[\s*DEBUG\s*\]|debug/i.test(line)) return "debug";
	return "info";
}
