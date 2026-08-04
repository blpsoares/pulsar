import { dirname } from "node:path";
import { Box, Text } from "ink";
import type { DetectedConfig } from "../../core/compose/detectConfigs";
import { shortenPath } from "../layout";
import { useClickable } from "../mouse/MouseProvider";
import { theme } from "../theme";
import { windowRange } from "./Select";

/**
 * Lista de configs agrupada por pasta, com seções que abrem e fecham.
 *
 * Nasceu da varredura recursiva: achar configs em toda a árvore só ajuda se dá
 * para navegar entre elas — uma lista corrida de trinta caminhos longos é pior
 * do que a lista curta de antes.
 *
 * A navegação trabalha sobre LINHAS ACHATADAS (cabeçalhos + itens visíveis),
 * não sobre a árvore: assim seta para baixo faz o óbvio, atravessando de uma
 * seção para a outra, sem estado de "em qual nível estou".
 */

export type TreeRow =
	| { kind: "group"; dir: string; count: number; collapsed: boolean }
	| { kind: "item"; dir: string; config: DetectedConfig };

export function buildRows(
	configs: DetectedConfig[],
	collapsed: ReadonlySet<string>,
): TreeRow[] {
	const groups = new Map<string, DetectedConfig[]>();

	for (const config of configs) {
		// "." é o diretório onde a TUI foi aberta; ele vem primeiro na ordenação
		// justamente por ser o mais provável de conter o que se procura.
		const dir = dirname(config.file);
		const list = groups.get(dir);
		if (list) list.push(config);
		else groups.set(dir, [config]);
	}

	const dirs = [...groups.keys()].sort(compareDirs);
	const rows: TreeRow[] = [];

	for (const dir of dirs) {
		const items = groups.get(dir) ?? [];
		const isCollapsed = collapsed.has(dir);
		rows.push({
			kind: "group",
			dir,
			count: items.length,
			collapsed: isCollapsed,
		});
		if (isCollapsed) continue;
		for (const config of items) rows.push({ kind: "item", dir, config });
	}

	return rows;
}

/** Diretório atual primeiro; depois os mais rasos; depois alfabético. */
function compareDirs(a: string, b: string): number {
	if (a === b) return 0;
	if (a === ".") return -1;
	if (b === ".") return 1;

	const depth = a.split("/").length - b.split("/").length;
	return depth !== 0 ? depth : a.localeCompare(b);
}

export function ConfigTree({
	rows,
	index,
	width,
	visible,
	focused,
	onActivate,
	onHighlight,
}: {
	rows: TreeRow[];
	index: number;
	width: number;
	visible: number;
	focused: boolean;
	/** enter/clique confirmado: abre a config ou abre/fecha a seção */
	onActivate: (row: TreeRow, rowIndex: number) => void;
	/** cursor parou numa linha */
	onHighlight: (rowIndex: number) => void;
}) {
	const ref = useClickable({
		onClick: ({ row }) => {
			const { start } = windowRange(index, rows.length, visible);
			const offset = start > 0 ? 1 : 0;
			const target = start + row - offset;
			const hit = rows[target];
			if (!hit) return;

			// Clicar numa linha que já está sob o cursor confirma; nas outras, só
			// move — evita abrir config por engano num clique de passagem.
			if (target === index) onActivate(hit, target);
			else onHighlight(target);
		},
		onWheel: (direction) =>
			onHighlight(
				Math.max(0, Math.min(rows.length - 1, index + direction * 3)),
			),
	});

	if (rows.length === 0)
		return (
			<Box flexDirection="column">
				<Text color={theme.muted}>nenhuma config do pulsar por aqui.</Text>
				<Text color={theme.muted}>
					tecle <Text color={theme.accent}>n</Text> para criar a primeira.
				</Text>
			</Box>
		);

	const { start, end } = windowRange(index, rows.length, visible);
	// -4 de borda/padding, -20 das colunas de modo e destino, -2 do recuo
	const nameWidth = Math.max(14, width - 26);
	// cabeçalho: -4 de borda/padding, -2 do marcador e da seta, -6 do "(N)"
	const dirWidth = Math.max(10, width - 12);

	return (
		<Box flexDirection="column" ref={ref}>
			{start > 0 ? <Text color={theme.border}> ↑ {start} acima</Text> : null}

			{rows.slice(start, end).map((row, i) => {
				const active = start + i === index;
				const color = active
					? focused
						? theme.selection
						: theme.label
					: undefined;

				if (row.kind === "group")
					return (
						<Text key={`g:${row.dir}`} color={color ?? theme.accent} bold>
							{active ? "▍" : " "}
							{row.collapsed ? "▸" : "▾"} {prettyDir(row.dir, dirWidth)}{" "}
							<Text color={theme.border}>({row.count})</Text>
						</Text>
					);

				const config = row.config;
				return (
					<Text
						key={`i:${config.file}`}
						color={color}
						bold={active}
						wrap="truncate-end"
					>
						{active ? "▍" : " "}
						{"  "}
						{pad(baseName(config.file), nameWidth)}
						<Text color={kindColor(config.kind)}>{pad(config.kind, 9)}</Text>
						<Text color={theme.muted}>
							{config.destDb ?? config.sourceDb ?? "—"}
						</Text>
					</Text>
				);
			})}

			{end < rows.length ? (
				<Text color={theme.border}> ↓ {rows.length - end} abaixo</Text>
			) : null}
		</Box>
	);
}

/**
 * Caminho da seção. Encurta pelo MEIO quando não cabe (`pulsar/…/staging`), em
 * vez de cortar o fim: a última pasta é a que distingue duas seções irmãs, e
 * `pulsar/ads-s…` — o que a sidebar estreita produzia — não identifica nada.
 */
function prettyDir(dir: string, width: number): string {
	return dir === "." ? "· aqui" : shortenPath(dir, width);
}

function baseName(file: string): string {
	const parts = file.split("/");
	return parts[parts.length - 1] ?? file;
}

function kindColor(kind: string): string {
	if (kind === "sync") return theme.accent;
	if (kind === "migrate") return theme.warn;
	return theme.ok;
}

function pad(text: string, width: number): string {
	if (text.length >= width) return `${text.slice(0, Math.max(0, width - 1))}…`;
	return text + " ".repeat(width - text.length);
}
