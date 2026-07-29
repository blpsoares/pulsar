/**
 * Paleta única da TUI.
 *
 * Duas famílias de cor, de propósito:
 *
 * - **Estados** (ok/warn/error/muted) em cores NOMEADAS do ANSI-16, que
 *   respeitam o tema do terminal do usuário — o mesmo verde funciona em fundo
 *   claro e escuro.
 * - **Identidade** (accent, borda, gradiente do wordmark) em hex, porque o
 *   ciano padrão do ANSI muda demais entre temas e a marca ficaria irreconhecível.
 *   O chalk rebaixa hex para 256/16 cores sozinho, então terminal antigo degrada
 *   em vez de quebrar.
 */
export const theme = {
	/** identidade: títulos, painel em foco, teclas */
	accent: "#22d3ee",
	/** item sob o cursor */
	selection: "#67e8f9",
	/** molduras e réguas — visível, mas nunca competindo com o conteúdo */
	border: "#3f4a5a",
	ok: "green",
	warn: "yellow",
	error: "red",
	muted: "gray",
	label: "white",
} as const;

/** Extremos do gradiente do wordmark: ciano → índigo. */
const GRADIENT_FROM = [34, 211, 238] as const;
const GRADIENT_TO = [129, 140, 248] as const;

/** N cores interpoladas — usado para colorir o wordmark caractere a caractere. */
export function gradient(steps: number): string[] {
	if (steps <= 1) return [rgb(GRADIENT_FROM)];
	return Array.from({ length: steps }, (_, i) => {
		const t = i / (steps - 1);
		return rgb([
			Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
			Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
			Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
		]);
	});
}

function rgb(c: readonly [number, number, number] | number[]): string {
	return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** Marcadores. Box-drawing e geométricos: presentes em qualquer fonte moderna. */
export const glyph = {
	checked: "◉",
	unchecked: "○",
	boxChecked: "[x]",
	boxUnchecked: "[ ]",
	cursor: "❯",
	view: "◇",
	collection: "▪",
	dot: "●",
	arrow: "⇄",
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;
