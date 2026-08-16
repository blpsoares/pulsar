import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { copyToClipboard, describeCopy } from "../../core/clipboard";
import { fitHints, SIDEBAR_WIDTH } from "../layout";
import { useMouse } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, gradient, theme } from "../theme";

export type { Layout } from "../layout";
export {
	ASIDE_WIDTH,
	CHROME_ROWS,
	layout,
	SIDEBAR_WIDTH,
	shortenPath,
} from "../layout";

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
						wrap="truncate-end"
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
	copy,
	overlay,
}: {
	chips: Chip[];
	hints: Hint[];
	children: ReactNode;
	columns: number;
	rows: number;
	notice?: { text: string; tone?: "ok" | "warn" | "error" };
	/**
	 * O que Ctrl+C copia nesta tela. Fica no Shell (e não em cada tela) porque
	 * o atalho e o aviso de "copiado" são os mesmos em toda a TUI.
	 */
	copy?: () => string | null;
	/**
	 * Camada desenhada por cima do corpo (ex.: menu de ações, ajuda). Entra
	 * DEPOIS do corpo e ANTES da KeyBar: como é `position="absolute"`, não
	 * empurra a barra de teclas para baixo.
	 */
	overlay?: ReactNode;
}) {
	const toast = useCopyShortcut(copy);
	const mouse = useMouse();

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Header chips={chips} columns={columns} />
			<Box flexDirection="row" flexGrow={1}>
				{children}
			</Box>
			{overlay}
			<KeyBar
				hints={hints}
				notice={toast ?? notice}
				mouse={mouse.enabled}
				columns={columns}
			/>
		</Box>
	);
}

/**
 * Ctrl+C copia o que a tela indicar.
 *
 * Ele NÃO encerra mais a TUI: sair é `q` ou Ctrl+D, ambos anunciados na barra
 * de teclas. A troca é deliberada — num app de tela cheia, com mouse ligado, a
 * seleção nativa do terminal não funciona, e sem um atalho de cópia não haveria
 * como levar uma URI ou um caminho para fora daqui.
 */
function useCopyShortcut(
	copy?: () => string | null,
): { text: string; tone: "ok" | "warn" } | undefined {
	const [toast, setToast] = useState<
		{ text: string; tone: "ok" | "warn" } | undefined
	>();
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const show = (text: string, tone: "ok" | "warn") => {
		setToast({ text, tone });
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setToast(undefined), 2500);
	};

	// `isActive: Boolean(copy)` não é otimização: sem ele, o `ctrl+c` continuava
	// copiando o item da LISTA com um formulário ou detalhe abertos por cima —
	// e nem `KEYS.detail` nem `KEYS.form` anunciam esse atalho. A tela que não
	// passa `copy` simplesmente não escuta a tecla.
	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!key.ctrl || input !== "c") return;

			const value = copy?.();
			if (!value) {
				show("nada para copiar nesta tela", "warn");
				return;
			}

			const result = copyToClipboard(value);
			show(
				result.ok
					? `copiado: ${describeCopy(value)}`
					: "não consegui copiar (terminal sem OSC 52 e sem pbcopy/wl-copy/xclip)",
				result.ok ? "ok" : "warn",
			);
		},
		{ isActive: Boolean(copy) },
	);

	return toast;
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

/** Altura reservada para as teclas — ver CHROME_ROWS em layout.ts. */
const KEYBAR_ROWS = 1;

function KeyBar({
	hints,
	notice,
	mouse,
	columns,
}: {
	hints: Hint[];
	notice?: { text: string; tone?: "ok" | "warn" | "error" };
	/** rastreamento de cliques ligado: só então shift+arrastar é notícia */
	mouse: boolean;
	columns: number;
}) {
	return (
		<Box flexDirection="column">
			{/* linha sempre presente — ver CHROME_ROWS em layout.ts */}
			<Text color={toneColor(notice?.tone)} wrap="truncate-end">
				{notice?.text ?? " "}
			</Text>
			<Text wrap="truncate-end">
				{/*
				 * A saída é acrescentada pelo Shell, não por cada tela: uma tela que
				 * esquecesse de anunciá-la (ou que a anunciasse errado) deixaria o
				 * usuário preso sem saber como sair. Aqui isso é impossível.
				 *
				 * E o orçamento é calculado ANTES de renderizar (`fitHints`): o
				 * `truncate-end` cortava a lista sempre no mesmo ponto, e quem caía
				 * fora era o FIM dela — justamente onde mora "ctrl+d sair da TUI".
				 * Agora as obrigatórias reservam espaço primeiro e as teclas da tela
				 * ocupam o resto, na ordem em que a tela as listou.
				 */}
				{fitHints(
					[],
					hints,
					[
						// Com o mouse rastreando cliques, a seleção nativa do terminal só
						// volta com shift (o MouseProvider ignora todo evento com shift).
						// Sem este anúncio, o usuário descobre isso lendo o código-fonte.
						...(mouse
							? [{ keys: "shift+arrastar", label: "selecionar texto" }]
							: []),
						{ keys: "ctrl+d", label: "sair da TUI" },
					],
					columns,
					KEYBAR_ROWS,
				).map((h, i) => (
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
