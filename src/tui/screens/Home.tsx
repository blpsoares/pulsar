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
import { windowRange } from "../components/Select";
import {
	type Chip,
	layout,
	Panel,
	Shell,
	Sidebar,
	Stat,
} from "../components/Shell";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { glyph, theme } from "../theme";

/**
 * Cockpit inicial: menu à esquerda, configs da pasta no centro, detalhe da
 * config sob o cursor à direita.
 *
 * `tab` alterna o foco entre menu e lista — é o que permite agir direto sobre
 * uma config (rodar, background, logs) sem passar pelo menu, do mesmo jeito que
 * um k9s age sobre o recurso selecionado.
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
	| { type: "logs"; file?: string }
	| { type: "quit" };

const MENU = [
	{ key: "new", label: "nova config", icon: "✚" },
	{ key: "run", label: "rodar", icon: "▶" },
	{ key: "open", label: "editar", icon: "✎" },
	{ key: "services", label: "background", icon: "⬢" },
	{ key: "logs", label: "logs", icon: "▤" },
	{ key: "quit", label: "sair", icon: "⏻" },
];

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

	const [reloadKey, setReloadKey] = useState(0);
	const [pane, setPane] = useState<"menu" | "list">("list");
	const [menuIndex, setMenuIndex] = useState(0);
	const [listIndex, setListIndex] = useState(0);

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
	const l = layout(columns, rows, Boolean(notice) || scan.truncated);

	const selected = configs[Math.min(listIndex, configs.length - 1)];
	const status = useServiceStatus(dir, selected?.file);

	useInput((input, key) => {
		if (key.tab) {
			setPane((p) => (p === "menu" ? "list" : "menu"));
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
		// Atalhos de ação valem nos DOIS painéis: eles agem sobre a config
		// selecionada, e exigir foco na lista para usá-los era uma pegadinha —
		// a tecla simplesmente não fazia nada e nada explicava por quê.
		if (selected) {
			if (input === "r") {
				onAction({ type: "run", file: selected.file });
				return;
			}
			if (input === "b") {
				onAction({ type: "services", file: selected.file });
				return;
			}
			if (input === "l") {
				onAction({ type: "logs", file: selected.file });
				return;
			}
		}

		if (pane === "menu") {
			if (key.upArrow) setMenuIndex((i) => (i === 0 ? MENU.length - 1 : i - 1));
			if (key.downArrow)
				setMenuIndex((i) => (i === MENU.length - 1 ? 0 : i + 1));
			if (key.return) {
				const item = MENU[menuIndex];
				if (!item) return;
				if (item.key === "new") onAction({ type: "new" });
				else if (item.key === "quit") onAction({ type: "quit" });
				else if (item.key === "services")
					onAction({ type: "services", file: selected?.file });
				else if (item.key === "logs")
					onAction({ type: "logs", file: selected?.file });
				else if (selected)
					onAction(
						item.key === "run"
							? { type: "run", file: selected.file }
							: { type: "open", file: selected.file },
					);
			}
			return;
		}

		if (configs.length === 0) return;
		if (key.upArrow)
			setListIndex((i) => (i === 0 ? configs.length - 1 : i - 1));
		if (key.downArrow)
			setListIndex((i) => (i === configs.length - 1 ? 0 : i + 1));
		if (key.return && selected) onAction({ type: "open", file: selected.file });
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
				notice
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
			hints={[
				{ keys: "tab", label: "painel" },
				{ keys: "↑↓", label: "navegar" },
				{ keys: "enter", label: pane === "menu" ? "abrir" : "editar" },
				{ keys: "r", label: "rodar" },
				{ keys: "b", label: "background" },
				{ keys: "l", label: "logs" },
				{ keys: "q", label: "sair" },
			]}
		>
			<Sidebar
				items={MENU}
				activeKey={MENU[menuIndex]?.key ?? "new"}
				height={l.body}
				focused={pane === "menu"}
			/>

			<Panel
				title={`configs · ${basename(dir) || dir}`}
				width={l.center}
				height={l.body}
				focused={pane === "list"}
			>
				<ConfigList
					configs={configs}
					index={listIndex}
					width={l.center}
					visible={l.panelRows - 1}
					focused={pane === "list"}
				/>
			</Panel>

			{l.aside > 0 ? (
				<Panel title="detalhe" width={l.aside} height={l.body}>
					<Detail dir={dir} config={selected} width={l.aside} status={status} />
				</Panel>
			) : null}
		</Shell>
	);
}

function ConfigList({
	configs,
	index,
	width,
	visible,
	focused,
}: {
	configs: DetectedConfig[];
	index: number;
	width: number;
	visible: number;
	focused: boolean;
}) {
	if (configs.length === 0)
		return (
			<Box flexDirection="column">
				<Text color={theme.muted}>nenhuma config do pulsar nesta pasta.</Text>
				<Text color={theme.muted}>
					tecle <Text color={theme.accent}>tab</Text> e escolha{" "}
					<Text color={theme.accent}>nova config</Text> para criar a primeira.
				</Text>
			</Box>
		);

	const { start, end } = windowRange(index, configs.length, visible);
	// -4 de padding/borda, -22 das colunas de modo e destino
	const nameWidth = Math.max(12, width - 26);

	return (
		<Box flexDirection="column">
			<Text color={theme.border}>
				{"  "}
				{pad("arquivo", nameWidth - 2)}
				{pad("modo", 9)}destino
			</Text>
			{configs.slice(start, end).map((c, i) => {
				const active = start + i === index;
				return (
					<Text
						key={c.file}
						color={
							active ? (focused ? theme.selection : theme.label) : undefined
						}
						bold={active}
						wrap="truncate-end"
					>
						{active ? `${glyph.cursor} ` : "  "}
						{pad(c.file, nameWidth - 2)}
						<Text color={kindColor(c.kind)}>{pad(c.kind, 9)}</Text>
						<Text color={theme.muted}>{c.destDb ?? c.sourceDb ?? "—"}</Text>
					</Text>
				);
			})}
		</Box>
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

function kindColor(kind: string): string {
	if (kind === "sync") return theme.accent;
	if (kind === "migrate") return theme.warn;
	return theme.ok;
}

function viewsLabel(copyViews: boolean | string[] | undefined): string {
	if (copyViews === true) return "todas";
	if (Array.isArray(copyViews)) return String(copyViews.length);
	return "não";
}

function pad(text: string, width: number): string {
	if (text.length >= width) return `${text.slice(0, Math.max(0, width - 1))}…`;
	return text + " ".repeat(width - text.length);
}

function safeSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
