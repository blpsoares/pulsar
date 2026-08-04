import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
	type DetectedConfig,
	detectConfigsWithMeta,
} from "../../core/compose/detectConfigs";
import { loadConfigFile } from "../../core/config/loadConfig";
import { formatBytes } from "../../core/inspect/collStats";
import { shortUri } from "../../core/inspect/maskUri";
import { detectBackends, preferredBackend } from "../../core/service/detect";
import { serviceStatus } from "../../core/service/manager";
import type { Backend, ServiceStatus } from "../../core/service/types";
import { type Action, ActionMenu } from "../components/ActionMenu";
import { buildRows, ConfigTree, type TreeRow } from "../components/ConfigTree";
import { type Chip, layout, Panel, Shell, Stat } from "../components/Shell";
import { useBackgroundStart } from "../hooks/useBackgroundStart";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { useMouse } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

/**
 * Aba `configs`: a lista de ymls da pasta ocupando a tela, com o detalhe da
 * config sob o cursor à direita.
 *
 * A antiga sidebar de menu saiu daqui. Ela cobrava 19 colunas permanentes para
 * quatro itens globais (nova config, background, logs, sair) e era a causa dos
 * caminhos cortados no meio — `pulsar/ads-s…`. Três desses itens viraram ABA no
 * topo e o quarto virou tecla (`n` cria, `q` sai), ambos anunciados na barra de
 * teclas. A largura liberada foi inteira para a lista.
 *
 * O painel da direita mostra também se aquela config JÁ está instalada como
 * serviço, e em que estado. É a pergunta que mais se faz numa VM ("isso aqui
 * está rodando?") e que antes exigia sair da ferramenta.
 */

export type HomeAction =
	| { type: "new" }
	| { type: "open"; file: string }
	| { type: "run"; file: string }
	| { type: "services"; file?: string }
	| { type: "running" }
	| { type: "logs"; file?: string }
	| { type: "quit" };

export function Home({
	dir,
	onAction,
	notice,
}: {
	dir: string;
	onAction: (action: HomeAction) => void;
	notice?: string;
}) {
	const { columns, rows } = useTerminalSize();
	const mouse = useMouse();

	const [reloadKey, setReloadKey] = useState(0);
	const [rowIndex, setRowIndex] = useState(0);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	/** menu de ações do arquivo sob o cursor (aberto por enter/clique) */
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const background = useBackgroundStart(dir);

	/**
	 * Varredura RECURSIVA a partir do diretório atual: o usuário não precisa
	 * navegar até a pasta das configs para a TUI enxergá-las. Os limites da
	 * varredura (profundidade, node_modules e afins, teto de arquivos) estão em
	 * `detectConfigs` — abrir a TUI não pode custar um `find` na home.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey é a dependência — incrementá-lo relê o diretório
	const scan = useMemo(
		() => detectConfigsWithMeta(dir, { recursive: true }),
		[dir, reloadKey],
	);
	const configs = scan.configs.filter((c) => c.kind !== "desconhecido");
	const l = layout(columns, rows);

	const treeRows = buildRows(configs, collapsed);
	const cursor = Math.min(rowIndex, Math.max(0, treeRows.length - 1));
	const currentRow = treeRows[cursor];
	// O painel de detalhe segue o ITEM sob o cursor; sobre um cabeçalho de
	// seção, mantém o último item visto para a tela não piscar em branco.
	const selected =
		currentRow?.kind === "item"
			? currentRow.config
			: lastItemBefore(treeRows, cursor);
	const status = useServiceStatus(dir, selected?.file);

	function toggleGroup(groupDir: string) {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(groupDir)) next.delete(groupDir);
			else next.add(groupDir);
			return next;
		});
	}

	function activate(row: TreeRow) {
		// cabeçalho abre/fecha a seção; arquivo abre o menu de ações DELE
		if (row.kind === "group") toggleGroup(row.dir);
		else setMenuFor(row.config.file);
	}

	useInput((input, key) => {
		if (isMouseInput(input)) return;
		// Com o menu do arquivo aberto, é ELE que responde: a mesma tecla valendo
		// nos dois lugares foi o bug que já apareceu no seletor de collections.
		if (menuFor) return;
		if (input === "n") {
			// A antiga entrada "nova config" da sidebar. Vira tecla, não aba: criar
			// é um VERBO, e verbo em aba mente sobre o que a aba mostra.
			onAction({ type: "new" });
			return;
		}
		if (input === "R") {
			setReloadKey((k) => k + 1);
			return;
		}
		if (input === "q") {
			onAction({ type: "quit" });
			return;
		}
		if (input === "m") {
			// Desligar o mouse devolve a SELEÇÃO DE TEXTO nativa do terminal, que o
			// rastreamento de cliques necessariamente rouba. Fica aqui, na tela sem
			// campo de texto, para a tecla não colidir com digitação.
			mouse.toggle();
			return;
		}
		// Atalhos de ação valem nos DOIS painéis: eles agem sobre a config
		// selecionada, e exigir foco na lista para usá-los era uma pegadinha —
		// a tecla simplesmente não fazia nada e nada explicava por quê.
		if (selected) {
			if (input === "r") {
				onAction({ type: "run", file: selected.file });
				return;
			}
			if (input === "b") {
				// atalho direto: sobe em background com o backend nativo da máquina
				void background.start(selected.file);
				return;
			}
			if (input === "g") {
				onAction({ type: "services", file: selected.file });
				return;
			}
			if (input === "l") {
				onAction({ type: "logs", file: selected.file });
				return;
			}
		}

		if (treeRows.length === 0) return;
		if (key.upArrow)
			setRowIndex(cursor === 0 ? treeRows.length - 1 : cursor - 1);
		if (key.downArrow)
			setRowIndex(cursor === treeRows.length - 1 ? 0 : cursor + 1);
		if (key.leftArrow && currentRow) {
			// ← fecha a seção da linha atual, mesmo estando sobre um item dela
			setCollapsed((prev) => new Set(prev).add(currentRow.dir));
			return;
		}
		if (key.rightArrow && currentRow?.kind === "group" && currentRow.collapsed)
			toggleGroup(currentRow.dir);
		if ((key.return || input === " ") && currentRow) activate(currentRow);
	});

	const chips: Chip[] = [
		{ label: "pasta", value: basename(dir) || dir, tone: "muted" },
		{
			label: "configs",
			value: String(configs.length),
			tone: configs.length > 0 ? "ok" : "warn",
		},
	];
	if (status?.installed)
		chips.push({
			label: "serviço",
			value: status.running ? "rodando" : "parado",
			tone: status.running ? "ok" : "warn",
		});

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			notice={
				background.busy
					? { text: "instalando e subindo o serviço…" }
					: background.result
						? {
								text: background.result.message,
								tone: background.result.ok ? "ok" : "error",
							}
						: notice
							? { text: notice, tone: "warn" }
							: scan.truncated
								? {
										// Varredura cortada sem aviso faria o usuário concluir que a
										// config dele não existe.
										text: `varredura parcial (${scan.dirsVisited} pastas): abra a TUI mais perto das suas configs para ver todas`,
										tone: "warn",
									}
								: undefined
			}
			copy={() => (selected ? resolve(dir, selected.file) : null)}
			hints={[
				{ keys: "↑↓", label: "navegar" },
				{ keys: "enter", label: "ações do arquivo" },
				{ keys: "←→", label: "fechar/abrir seção" },
				{ keys: "n", label: "nova config" },
				{ keys: "r", label: "rodar" },
				{ keys: "b", label: "subir em background" },
				{ keys: "l", label: "logs" },
				{ keys: "ctrl+c", label: "copiar caminho" },
				{
					keys: "m",
					label: `mouse ${mouse.enabled ? "on" : "off"}`,
				},
				{ keys: "q", label: "sair" },
			]}
		>
			<Panel
				title={`configs · ${basename(dir) || dir}`}
				width={l.center}
				height={l.body}
				focused
			>
				{menuFor ? (
					<ActionMenu
						title={menuFor}
						width={l.center}
						actions={actionsFor(status)}
						onClose={() => setMenuFor(null)}
						onPick={(action) => {
							const file = menuFor;
							setMenuFor(null);
							if (!file) return;
							if (action === "e") onAction({ type: "open", file });
							else if (action === "r") onAction({ type: "run", file });
							else if (action === "b") void background.start(file);
							else if (action === "g") onAction({ type: "services", file });
							else if (action === "l") onAction({ type: "logs", file });
						}}
					/>
				) : (
					<ConfigTree
						rows={treeRows}
						index={cursor}
						width={l.center}
						visible={l.panelRows - 1}
						focused
						onActivate={activate}
						onHighlight={setRowIndex}
					/>
				)}
			</Panel>

			{l.aside > 0 ? (
				<Panel title="detalhe" width={l.aside} height={l.body}>
					<Detail dir={dir} config={selected} width={l.aside} status={status} />
				</Panel>
			) : null}
		</Shell>
	);
}

function Detail({
	dir,
	config,
	width,
	status,
}: {
	dir: string;
	config?: DetectedConfig;
	width: number;
	status: ServiceStatus | null;
}) {
	if (!config)
		return <Text color={theme.muted}>selecione uma config na lista</Text>;

	const path = resolve(dir, config.file);
	const loaded = loadConfigFile(path);
	const form = loaded?.form;

	return (
		<Box flexDirection="column">
			<Text color={theme.accent} bold wrap="truncate-end">
				{config.file}
			</Text>

			<Box marginTop={1} flexDirection="column">
				<Stat label="modo" value={config.kind} width={width} />
				<Stat label="origem" value={form?.source.db ?? "—"} width={width} />
				{config.kind !== "ttl" ? (
					<Stat
						label="destino"
						value={form?.destination.db ?? "—"}
						width={width}
					/>
				) : null}
				<Stat
					label="colls"
					value={String(form?.collections.length ?? 0)}
					width={width}
				/>
				{config.kind === "sync" ? (
					<>
						<Stat
							label="índices"
							value={form?.copyIndexes ? "copia" : "não"}
							width={width}
							tone={form?.copyIndexes ? "ok" : "muted"}
						/>
						<Stat
							label="views"
							value={viewsLabel(form?.copyViews)}
							width={width}
							tone={form?.copyViews ? "ok" : "muted"}
						/>
					</>
				) : null}
				<Stat
					label="arquivo"
					value={formatBytes(safeSize(path))}
					width={width}
					tone="muted"
				/>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text color={theme.border}>─ serviço ─</Text>
				{status === null ? (
					<Text color={theme.muted}>checando…</Text>
				) : status.installed ? (
					<>
						<Stat
							label="estado"
							value={status.running ? "rodando" : "parado"}
							width={width}
							tone={status.running ? "ok" : "warn"}
						/>
						<Stat
							label="no boot"
							value={status.enabled ? "sim" : "não"}
							width={width}
							tone={status.enabled ? "ok" : "muted"}
						/>
					</>
				) : (
					<Text color={theme.muted}>não instalado</Text>
				)}
			</Box>

			{form?.source.uri ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.border}>─ uri origem ─</Text>
					<Text color={theme.muted} wrap="truncate-end">
						{shortUri(form.source.uri, width - 4)}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

/**
 * Status do serviço da config selecionada.
 *
 * Consultar o supervisor custa um processo filho, então roda com atraso:
 * navegar rápido pela lista não dispara uma consulta por tecla, só quando o
 * cursor para.
 */
function useServiceStatus(dir: string, file?: string): ServiceStatus | null {
	const [status, setStatus] = useState<ServiceStatus | null>(null);
	const [backend, setBackend] = useState<Backend | null>(null);

	useEffect(() => {
		void detectBackends(false).then((a) => setBackend(preferredBackend(a)));
	}, []);

	useEffect(() => {
		if (!file || !backend) return;
		setStatus(null);
		let alive = true;

		const timer = setTimeout(() => {
			const path = resolve(dir, file);
			const loaded = loadConfigFile(path);
			void serviceStatus(backend, {
				name: basename(file).replace(/\.ya?ml$/i, ""),
				mode: loaded?.form.mode ?? "sync",
				configPath: path,
				workingDir: dir,
				autostart: false,
			}).then((s) => {
				if (alive) setStatus(s);
			});
		}, 250);

		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [dir, file, backend]);

	return status;
}

/**
 * Ações do arquivo sob o cursor. A dica de "gerenciar" muda conforme já exista
 * serviço instalado — é a informação que decide se você vem aqui para instalar
 * ou para parar/remover.
 */
function actionsFor(status: ServiceStatus | null): Action[] {
	return [
		{ key: "e", label: "editar config", hint: "abre o form" },
		{ key: "r", label: "rodar aqui", hint: "primeiro plano, saída ao vivo" },
		{
			key: "b",
			label: "iniciar em background",
			hint: "instala o serviço e liga no boot",
			warn: true,
		},
		{
			key: "g",
			label: "gerenciar background",
			hint: status?.installed
				? "instalado — parar, remover, trocar backend"
				: "escolher backend e ver o plano",
		},
		{ key: "l", label: "ver logs", hint: "gravados e ao vivo" },
	];
}

/** Item mais próximo acima do cursor — usado quando ele está num cabeçalho. */
function lastItemBefore(
	rows: TreeRow[],
	index: number,
): DetectedConfig | undefined {
	for (let i = index; i >= 0; i--) {
		const row = rows[i];
		if (row?.kind === "item") return row.config;
	}
	return rows.find((r) => r.kind === "item")?.config;
}

function viewsLabel(copyViews: boolean | string[] | undefined): string {
	if (copyViews === true) return "todas";
	if (Array.isArray(copyViews)) return String(copyViews.length);
	return "não";
}

function safeSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
