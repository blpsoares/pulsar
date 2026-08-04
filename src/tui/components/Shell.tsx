import { Box, Text, useInput } from "ink";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { copyToClipboard, describeCopy } from "../../core/clipboard";
import { fitHints, tabAt, tabCells } from "../layout";
import { useClickable, useMouse } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, gradient, theme } from "../theme";

export type { Layout } from "../layout";
export {
	ASIDE_WIDTH,
	CHROME_ROWS,
	layout,
	RAIL_WIDTH,
	shortenPath,
} from "../layout";

/**
 * O esqueleto visual da TUI: cabeçalho, abas, painéis e barra de teclas.
 *
 * Layout de cockpit (k9s/lazygit): tudo à vista ao mesmo tempo, em painéis com
 * largura calculada a partir do tamanho do terminal — centro elástico e painel
 * de contexto fixo à direita.
 *
 * A navegação global vive numa FAIXA DE ABAS no topo, não numa coluna à
 * esquerda. A sidebar cobrava ~19 colunas de toda tela, o tempo inteiro, para
 * exibir quatro itens que quase nunca mudavam — e essas colunas faltavam
 * justamente onde a informação é longa (caminhos de config, linhas de log).
 * No topo, a mesma navegação custa duas linhas e devolve a largura ao
 * conteúdo.
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

// ------------------------------------------------------------------- abas

/** As telas RAIZ da TUI. Tudo o mais é sub-tela, aberta a partir de uma delas. */
export type TabKey = "configs" | "running" | "logs" | "service";

export const TABS: { key: TabKey; label: string; icon: string }[] = [
	{ key: "configs", label: "configs", icon: "▤" },
	{ key: "running", label: "rodando", icon: "⬢" },
	{ key: "logs", label: "logs", icon: "▤" },
	{ key: "service", label: "serviço", icon: "◈" },
];

export type NavContextValue = {
	/** aba de ORIGEM: numa sub-tela, continua acesa a aba de onde ela partiu */
	tab: TabKey;
	/** rótulo da sub-tela; ausente quando a própria aba está na tela */
	crumb?: string;
	go: (key: TabKey) => void;
};

const NavContext = createContext<NavContextValue | null>(null);

/**
 * O roteador (App) publica aqui em que aba estamos e como trocar.
 *
 * Via contexto, e não por prop de cada tela: uma tela nova que esquecesse de
 * repassar a prop apareceria sem abas — quebrando a altura fixa do chrome e
 * deixando o usuário sem navegação, exatamente o tipo de erro que o desenho
 * anterior (`ctrl+d` anunciado pelo Shell) já tinha aprendido a evitar.
 */
export function NavProvider({
	value,
	children,
}: {
	value: NavContextValue;
	children: ReactNode;
}) {
	return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

function TabBar({
	columns,
	nav,
}: {
	columns: number;
	nav: NavContextValue | null;
}) {
	const cells = tabCells(TABS.map((t) => t.label));
	const activeIndex = TABS.findIndex((t) => t.key === nav?.tab);

	// O clique é mapeado por COLUNA (a faixa é horizontal), ao contrário das
	// listas, que mapeiam por linha. A conta das células é a mesma do desenho.
	const ref = useClickable({
		onClick: ({ column }) => {
			const hit = tabAt(cells, column);
			const target = TABS[hit];
			if (target) nav?.go(target.key);
		},
	});

	const strip = cells.reduce((sum, c) => sum + c.width, 0);
	const rest = Math.max(0, columns - strip);

	return (
		<Box flexDirection="column">
			<Box ref={ref} flexDirection="row">
				<Text>
					{TABS.map((tab, i) => {
						const active = i === activeIndex;
						return (
							<Text
								key={tab.key}
								color={active ? theme.accent : theme.muted}
								bold={active}
								underline={active && !nav?.crumb}
							>
								{" "}
								{i + 1} {tab.label}
								{"  "}
							</Text>
						);
					})}
				</Text>
				{nav?.crumb ? (
					<Text wrap="truncate-end">
						<Text color={theme.border}>{glyph.cursor} </Text>
						<Text color={theme.selection} bold>
							{nav.crumb}
						</Text>
					</Text>
				) : null}
			</Box>

			{/* Régua: o trecho sob a aba ativa em accent — é o "sublinhado" que
			    sobrevive a terminal sem suporte a underline. */}
			<Text>
				{cells.map((cell, i) => (
					<Text
						key={TABS[i]?.key ?? String(i)}
						color={i === activeIndex ? theme.accent : theme.border}
						bold={i === activeIndex}
					>
						{"─".repeat(cell.width)}
					</Text>
				))}
				<Text color={theme.border}>{"─".repeat(rest)}</Text>
			</Text>
		</Box>
	);
}

/**
 * Teclado das abas: `1..4` direto, `shift+tab` e `ctrl+←/→` circulando.
 *
 * `tab` sozinho continua sendo o FOCO dentro da tela — são coisas diferentes e
 * misturá-las faria o usuário perder o painel em que estava só por querer
 * trocar de assunto. Os dígitos são desligáveis (`digitKeys`) porque em tela
 * com campo de texto — o wizard, a busca dos logs — digitar "2" tem que
 * escrever "2", não pular de aba.
 */
function useTabKeys(
	nav: NavContextValue | null,
	locked: boolean,
	digitKeys: boolean,
): void {
	useInput((input, key) => {
		if (isMouseInput(input) || !nav || locked) return;

		const index = TABS.findIndex((t) => t.key === nav.tab);
		if (key.tab && key.shift) {
			const prev = TABS[(index - 1 + TABS.length) % TABS.length];
			if (prev) nav.go(prev.key);
			return;
		}
		if (key.ctrl && (key.leftArrow || key.rightArrow)) {
			const step = key.rightArrow ? 1 : -1;
			const next = TABS[(index + step + TABS.length) % TABS.length];
			if (next) nav.go(next.key);
			return;
		}
		if (!digitKeys) return;
		if (!/^[1-9]$/.test(input)) return;
		const target = TABS[Number(input) - 1];
		if (target) nav.go(target.key);
	});
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
	lockTabs = false,
	digitKeys = true,
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
	 * Trava a troca de aba. É para a tela que tem algo VIVO a perder — o Runner
	 * com um sync rodando: trocar de aba desmonta o filho, e um sync não pode
	 * morrer por causa de um `2` digitado sem querer.
	 */
	lockTabs?: boolean;
	/** desligue onde há campo de texto: `1..4` precisa escrever, não navegar */
	digitKeys?: boolean;
}) {
	const toast = useCopyShortcut(copy);
	const nav = useContext(NavContext);
	const mouse = useMouse();
	useTabKeys(nav, lockTabs, digitKeys);

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Header chips={chips} columns={columns} />
			<TabBar columns={columns} nav={nav} />
			<Box flexDirection="row" flexGrow={1}>
				{children}
			</Box>
			<KeyBar
				hints={hints}
				notice={toast ?? notice}
				tabs={nav !== null && !lockTabs}
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

	useInput((input, key) => {
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
	});

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
const KEYBAR_ROWS = 2;

function KeyBar({
	hints,
	notice,
	tabs,
	mouse,
	columns,
}: {
	hints: Hint[];
	notice?: { text: string; tone?: "ok" | "warn" | "error" };
	/** anuncia a troca de aba — some quando a tela a trava (processo vivo) */
	tabs: boolean;
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
			{/*
			 * Duas linhas, com quebra por palavra em vez de `truncate-end`.
			 * Truncar cortava a lista SEMPRE no mesmo ponto — a 140 colunas a tela
			 * inicial terminava em "ctrl+c …" e as teclas seguintes (mouse, sair)
			 * simplesmente não existiam para quem lê. A altura é fixa (e reservada
			 * no CHROME_ROWS), então a segunda linha não empurra nada: ou está
			 * ocupada, ou está em branco.
			 */}
			<Box width={columns} height={KEYBAR_ROWS} flexShrink={0}>
				<Text>
					{/*
					 * Abas, seleção de texto e saída são acrescentadas pelo Shell, não
					 * por cada tela: uma tela que esquecesse de anunciá-las (ou que as
					 * anunciasse errado) deixaria o usuário preso sem saber como sair.
					 * Aqui isso é impossível.
					 */}
					{fitHints(
						tabs ? [{ keys: "1-4", label: "abas" }] : [],
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
