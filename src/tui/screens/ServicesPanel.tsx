import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { discoverServices } from "../../core/service/discover";
import { reconcile, type ServiceRow } from "../../core/state/reconcile";
import { listRecords } from "../../core/state/registry";
import { useClickable } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

/**
 * A lista de serviços é a tela raiz — não há mais "tela inicial" separada.
 *
 * Ela é GLOBAL à máquina: serviço não pertence a uma pasta, e abrir a TUI em
 * outro diretório não pode fazer serviço sumir. Só a lista de ymls do
 * formulário depende do diretório atual.
 */

export function useServiceRows(reloadKey: number) {
	const [rows, setRows] = useState<ServiceRow[]>([]);
	const [loading, setLoading] = useState(true);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey é a dependência — incrementá-lo força a releitura, mesmo sem aparecer no corpo do efeito
	useEffect(() => {
		let alive = true;
		setLoading(true);

		void (async () => {
			// O registro é síncrono (arquivos locais); a descoberta consulta quatro
			// supervisores e é a parte lenta — daí o estado de carregando.
			const records = listRecords();
			const live = await discoverServices();
			if (!alive) return;
			setRows(reconcile(records, live));
			setLoading(false);
		})();

		return () => {
			alive = false;
		};
	}, [reloadKey]);

	return { rows, loading };
}

const STATE_GLYPH = {
	running: { icon: "●", tone: theme.ok, label: "no ar" },
	stopped: { icon: "○", tone: theme.muted, label: "parado" },
	done: { icon: "✓", tone: theme.ok, label: "concluído" },
	failed: { icon: "✗", tone: theme.error, label: "erro" },
	uninstalled: { icon: "⊘", tone: theme.warn, label: "não instalado" },
	adopted: { icon: "◍", tone: theme.warn, label: "adotado" },
} as const;

function Row({
	row,
	width,
	selected,
}: {
	row: ServiceRow;
	width: number;
	selected: boolean;
}) {
	const state = STATE_GLYPH[row.state];
	const mode = row.record?.mode ?? "—";
	const backend = row.record?.backend ?? row.live?.backend ?? "—";
	const boot = row.record?.boot || row.live?.enabled ? "boot" : "—";

	return (
		<Text
			wrap="truncate-end"
			color={selected ? theme.selection : theme.label}
			bold={selected}
		>
			{selected ? "▍" : " "}
			<Text color={state.tone}>{state.icon} </Text>
			{row.name.padEnd(Math.max(10, Math.min(28, width - 40)))}
			<Text color={theme.muted}>
				{" "}
				{mode.padEnd(8)}
				{backend.padEnd(9)}
				{boot.padEnd(6)}
				{state.label}
			</Text>
		</Text>
	);
}

export function ServicesPanel({
	rows,
	loading,
	columns,
	screenRows,
	cursor,
	setCursor,
	onOpen,
	onNew,
	onLogs,
	onQuit,
	onReload,
	enabled,
}: {
	rows: ServiceRow[];
	loading: boolean;
	columns: number;
	/** altura da tela — nome distinto de `rows` (dados) para não colidir com ele */
	screenRows: number;
	cursor: number;
	setCursor: (i: number) => void;
	onOpen: (row: ServiceRow) => void;
	onNew: () => void;
	onLogs: (row: ServiceRow) => void;
	onQuit: () => void;
	onReload: () => void;
	/** false quando um overlay está por cima — só a camada de cima escuta */
	enabled: boolean;
}) {
	const selected = rows[cursor];

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (key.upArrow) setCursor(cursor === 0 ? rows.length - 1 : cursor - 1);
			if (key.downArrow) setCursor(cursor === rows.length - 1 ? 0 : cursor + 1);
			if (key.return && selected) onOpen(selected);
			if (input === "n") onNew();
			if (input === "l" && selected) onLogs(selected);
			if (input === "R") onReload();
			if (input === "q") onQuit();
		},
		{ isActive: enabled },
	);

	const listRef = useClickable({
		onClick: ({ row }) => {
			const index = row - 1;
			if (index >= 0 && index < rows.length) {
				setCursor(index);
				const target = rows[index];
				if (target) onOpen(target);
			}
		},
	});

	if (loading)
		return <Text color={theme.muted}>procurando serviços na máquina…</Text>;

	if (rows.length === 0)
		return (
			<Box flexDirection="column">
				<Text color={theme.muted}>nenhum serviço do pulsar nesta máquina.</Text>
				<Text> </Text>
				<Text>
					<Text color={theme.accent} bold>
						n
					</Text>
					<Text color={theme.muted}> cria o primeiro</Text>
				</Text>
			</Box>
		);

	// screenRows não decide quantas linhas desenhar aqui: a lista cresce dentro
	// do painel (Task 15 cuida do scroll/altura, como o ConfigTree já faz para
	// a lista de configs). Mantido na assinatura por ser o contrato do brief.
	void screenRows;

	return (
		<Box ref={listRef} flexDirection="column">
			{rows.map((row, i) => (
				<Row key={row.name} row={row} width={columns} selected={i === cursor} />
			))}
		</Box>
	);
}
