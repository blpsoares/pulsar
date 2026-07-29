import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { SIDEBAR_WIDTH } from "../layout";
import { glyph, gradient, theme } from "../theme";

export type { Layout } from "../layout";
export { ASIDE_WIDTH, CHROME_ROWS, layout, SIDEBAR_WIDTH } from "../layout";

/**
 * O esqueleto visual da TUI: cabeçalho, sidebar, painéis e barra de teclas.
 *
 * Layout de cockpit (k9s/lazygit): tudo à vista ao mesmo tempo, em painéis com
 * largura calculada a partir do tamanho do terminal — sidebar fixa, centro
 * elástico, painel de contexto fixo à direita.
 *
 * Por que os painéis desenham a borda de cima à mão: o `Box` do ink não sabe
 * escrever um título DENTRO da moldura. A saída é render manual da linha
 * superior (`╭─ título ───╮`) e um Box com `borderTop={false}` logo abaixo, que
 * cuida das laterais e do rodapé. As larguras são conhecidas (o Shell as
 * calcula), então a linha bate exatamente com a borda.
 */

// ---------------------------------------------------------------- wordmark

const WORDMARK = [
	"▛▀▖▌ ▌▌  ▞▀▖▞▀▖▙▀▖",
	"▙▄▘▌ ▌▌  ▝▀▖▙▄▌▌  ",
	"▌  ▝▀▘▀▀▘▝▀ ▌ ▌▌  ",
];

/**
 * Gradiente por caractere. O chalk rebaixa a cor sozinho em terminal de 256 ou
 * 16 cores, então isto degrada bem em vez de virar texto invisível.
 */
function GradientText({ line }: { line: string }) {
	const colors = gradient(line.length);
	return (
		<Text>
			{Array.from(line).map((char, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: caracteres de uma linha fixa
				<Text key={i} color={colors[i]} bold>
					{char}
				</Text>
			))}
		</Text>
	);
}

// ------------------------------------------------------------------ chips

export type Chip = {
	label: string;
	value: string;
	tone?: "ok" | "warn" | "error" | "muted";
};

function Chips({ chips }: { chips: Chip[] }) {
	return (
		<Text>
			{chips.map((chip, i) => (
				<Text key={chip.label}>
					{i > 0 ? <Text color={theme.border}>{"  │  "}</Text> : null}
					<Text color={toneColor(chip.tone)}>{glyph.dot} </Text>
					<Text color={theme.muted}>{chip.label} </Text>
					<Text color={theme.label} bold>
						{chip.value}
					</Text>
				</Text>
			))}
		</Text>
	);
}

// ----------------------------------------------------------------- painel

export function Panel({
	title,
	width,
	height,
	children,
	focused = false,
	footer,
	grow = false,
}: {
	title: string;
	width: number;
	height?: number;
	children: ReactNode;
	/** painel com foco recebe a borda destacada — é o que responde ao teclado */
	focused?: boolean;
	footer?: ReactNode;
	grow?: boolean;
}) {
	const color = focused ? theme.accent : theme.border;
	const label = ` ${title} `;
	// -2 dos cantos, -1 do traço inicial
	const fill = Math.max(0, width - label.length - 3);

	return (
		<Box flexDirection="column" width={width} flexGrow={grow ? 1 : 0}>
			<Text color={color}>
				╭─
				<Text color={focused ? theme.accent : theme.muted} bold={focused}>
					{label}
				</Text>
				{"─".repeat(fill)}╮
			</Text>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderTop={false}
				borderColor={color}
				paddingX={1}
				height={height}
				flexGrow={1}
			>
				<Box flexDirection="column" flexGrow={1}>
					{children}
				</Box>
				{footer ? <Box marginTop={1}>{footer}</Box> : null}
			</Box>
		</Box>
	);
}

// ---------------------------------------------------------------- sidebar

export type NavItem = { key: string; label: string; icon: string };

export function Sidebar({
	items,
	activeKey,
	height,
	focused,
	footer,
}: {
	items: NavItem[];
	activeKey: string;
	height: number;
	focused: boolean;
	footer?: ReactNode;
}) {
	return (
		<Panel
			title="menu"
			width={SIDEBAR_WIDTH}
			height={height}
			focused={focused}
			footer={footer}
		>
			{items.map((item) => {
				const active = item.key === activeKey;
				return (
					<Text
						key={item.key}
						color={active ? theme.accent : theme.muted}
						bold={active}
					>
						{active ? "▍" : " "}
						{item.icon} {item.label}
					</Text>
				);
			})}
		</Panel>
	);
}

// ------------------------------------------------------------------ shell

export type Hint = { keys: string; label: string };

export function Shell({
	chips,
	hints,
	children,
	columns,
	rows,
	notice,
}: {
	chips: Chip[];
	hints: Hint[];
	children: ReactNode;
	columns: number;
	rows: number;
	notice?: { text: string; tone?: "ok" | "warn" | "error" };
}) {
	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Header chips={chips} columns={columns} />
			<Box flexDirection="row" flexGrow={1}>
				{children}
			</Box>
			<KeyBar hints={hints} notice={notice} />
		</Box>
	);
}

function Header({ chips, columns }: { chips: Chip[]; columns: number }) {
	// Em terminal estreito o wordmark de 3 linhas rouba metade da tela útil;
	// abaixo de 100 colunas ele vira uma linha só.
	const compact = columns < 100;

	return (
		<Box flexDirection="row" height={3}>
			<Box flexDirection="column" width={22} flexShrink={0}>
				{compact ? (
					<GradientText line="▛▀▖▌ ▌▌ ▞▀▖▞▀▖▙▀▖" />
				) : (
					WORDMARK.map((line) => <GradientText key={line} line={line} />)
				)}
			</Box>
			<Box flexDirection="column" flexGrow={1} justifyContent="center">
				<Chips chips={chips} />
			</Box>
		</Box>
	);
}

function KeyBar({
	hints,
	notice,
}: {
	hints: Hint[];
	notice?: { text: string; tone?: "ok" | "warn" | "error" };
}) {
	return (
		<Box flexDirection="column">
			{notice ? (
				<Text color={toneColor(notice.tone)} wrap="truncate-end">
					{notice.text}
				</Text>
			) : null}
			<Text wrap="truncate-end">
				{hints.map((h, i) => (
					<Text key={h.keys}>
						{i > 0 ? <Text color={theme.border}>{" · "}</Text> : null}
						<Text color={theme.accent} bold>
							{h.keys}
						</Text>
						<Text color={theme.muted}> {h.label}</Text>
					</Text>
				))}
			</Text>
		</Box>
	);
}

// ------------------------------------------------------------- utilitários

/** Linha rótulo → valor, alinhada à direita: a régua dos painéis de contexto. */
export function Stat({
	label,
	value,
	width,
	tone,
}: {
	label: string;
	value: string;
	width: number;
	tone?: "ok" | "warn" | "error" | "muted";
}) {
	// -2 do padding do painel, -2 da borda
	const inner = Math.max(0, width - 4);
	const dots = Math.max(1, inner - label.length - value.length);

	return (
		<Text wrap="truncate-end">
			<Text color={theme.muted}>{label}</Text>
			<Text color={theme.border}>{" ".repeat(dots)}</Text>
			<Text color={toneColor(tone)} bold>
				{value}
			</Text>
		</Text>
	);
}

/** Barra horizontal de proporção — usada em uso de disco/progresso. */
export function Bar({
	ratio,
	width,
	color = theme.accent,
}: {
	ratio: number;
	width: number;
	color?: string;
}) {
	const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
	return (
		<Text>
			<Text color={color}>{"█".repeat(filled)}</Text>
			<Text color={theme.border}>{"░".repeat(width - filled)}</Text>
		</Text>
	);
}

export function toneColor(
	tone?: "ok" | "warn" | "error" | "muted",
): string | undefined {
	if (tone === "ok") return theme.ok;
	if (tone === "warn") return theme.warn;
	if (tone === "error") return theme.error;
	if (tone === "muted") return theme.muted;
	return theme.label;
}
