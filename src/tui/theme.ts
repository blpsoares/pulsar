/**
 * Paleta única da TUI. Centralizada porque cor espalhada por 15 componentes é
 * o caminho mais curto para uma tela que não parece a mesma tela.
 *
 * Só cores nomeadas do ANSI-16: elas respeitam o tema do terminal do usuário
 * (o mesmo cinza fica legível em fundo claro e escuro), enquanto hex fixo
 * some em metade dos temas.
 */
export const theme = {
	/** identidade do pulsar / títulos */
	accent: "cyan",
	/** item sob o cursor */
	selection: "cyanBright",
	/** sucesso, valor confirmado */
	ok: "green",
	/** atenção que não impede seguir */
	warn: "yellow",
	/** erro que impede seguir */
	error: "red",
	/** texto secundário, ajuda, unidades */
	muted: "gray",
	/** rótulo de campo */
	label: "white",
} as const;

/** Marcadores em ASCII-safe onde possível, para não quebrar em terminal pobre. */
export const glyph = {
	checked: "◉",
	unchecked: "○",
	boxChecked: "[x]",
	boxUnchecked: "[ ]",
	cursor: "❯",
	view: "◇",
	collection: "▪",
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;
