/**
 * Paleta única da TUI.
 *
 * Duas famílias de cor, de propósito:
 *
 * - **Estados** (ok/warn/error/muted) em cores NOMEADAS do ANSI-16, que
 *   respeitam o tema do terminal do usuário — o mesmo verde funciona em fundo
 *   claro e escuro.
 * - **Identidade** (accent, borda, gradiente do wordmark) em hex, ancorada no
 *   roxo da marca — o mesmo `#9b00ff` que o banner do figlet usa em
 *   `utils/showCliTitle.ts`. Hex e não `magenta` do ANSI porque o magenta muda
 *   demais entre temas de terminal e a marca ficaria irreconhecível. O chalk
 *   rebaixa hex para 256/16 cores sozinho, então terminal antigo degrada em vez
 *   de quebrar.
 */

/** Roxo da marca, igual ao do banner da CLI. */
const BRAND_RGB = [155, 0, 255] as const;
export const theme = {
	/**
	 * Identidade: títulos, painel em foco, teclas. Um tom acima do `BRAND`
	 * porque `#9b00ff` puro, em texto pequeno sobre fundo escuro, fica denso
	 * demais para ler — a marca cheia vive no wordmark, que é grande.
	 */
	accent: "#b44dff",
	/** item sob o cursor — o roxo mais claro da escala, para saltar da lista */
	selection: "#e0b3ff",
	/** molduras e réguas: violeta dessaturado, presente sem competir */
	border: "#4a3a5c",
	ok: "green",
	warn: "yellow",
	error: "red",
	muted: "gray",
	label: "white",
} as const;

/** Extremos do gradiente do wordmark: roxo da marca → magenta. */
const GRADIENT_FROM = BRAND_RGB;
const GRADIENT_TO = [255, 92, 244] as const;

/** O roxo da marca em hex — mesma fonte do gradiente, sem literal duplicado. */
export const BRAND = rgb(BRAND_RGB);

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
