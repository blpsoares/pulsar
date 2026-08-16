import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { discoverServices } from "../../core/service/discover";
import { reconcile, type ServiceRow } from "../../core/state/reconcile";
import { listRecords } from "../../core/state/registry";
import { listWindow } from "../layout";
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

	// O `Box` do ink 7 não recorta o próprio conteúdo — desenhar mais linhas do
	// que cabem no terminal não corta a saída, CORROMPE o frame (o ink não
	// consegue subir o cursor o bastante para apagar o quadro anterior).
	// Por isso a lista é fatiada ANTES de renderizar, com `listWindow` (pura,
	// testada em test/tuiKeys.test.ts), e não confiada ao layout do terminal.
	// Calculada mesmo nos estados de "carregando"/"vazio" (devolve janela vazia
	// sem custo) para o `useClickable` logo abaixo poder ficar ANTES dos
	// `return` antecipados — hooks não podem ser condicionais.
	//
	// Duas passadas: a 1ª decide a janela usando a altura cheia; se ela deixar
	// itens de fora, reserva-se 1 linha por indicador (acima/abaixo) e a janela
	// é recalculada com a altura reduzida — senão o indicador em si estouraria
	// a altura disponível.
	//
	// A reserva é LIMITADA pelo orçamento: com `screenRows` 1 ou 2, reservar uma
	// linha por indicador deixaria 1 item + 2 indicadores = 3 linhas num
	// orçamento de 2 — de novo o frame corrompido que o recorte existe para
	// evitar. Aqui a conta nunca deixa a soma passar de `screenRows`: primeiro o
	// item (sem ele a lista não é lista), depois os indicadores que couberem.
	const budget = Math.max(1, screenRows);
	const provisional = listWindow(rows.length, budget, cursor);
	const wanted =
		(provisional.start > 0 ? 1 : 0) + (provisional.end < rows.length ? 1 : 0);
	const reserved = Math.min(wanted, budget - 1);
	const win =
		reserved > 0
			? listWindow(rows.length, budget - reserved, cursor)
			: provisional;

	// Os indicadores DESENHADOS também são limitados a `reserved`: quando só
	// coube um e há corte dos dois lados, o de baixo é o que fica (rolar para o
	// fim da lista é o movimento comum).
	const above = win.start > 0;
	const below = win.end < rows.length;
	const hasMoreBelow = below && reserved > 0;
	const hasMoreAbove = above && reserved > (hasMoreBelow ? 1 : 0);
	const visible = rows.slice(win.start, win.end);

	const listRef = useClickable({
		onClick: ({ row }) => {
			// Não há linha de título dentro do `Box` abaixo (diferente de
			// `ActionMenu`/`Home`, onde a linha 0 é um título) — a linha 0 do
			// clique JÁ é o primeiro `Row` visível. Soma `win.start` para voltar
			// ao índice absoluto na lista completa (a janela pode estar rolada).
			// Não "padronize" de volta para `row - 1`: aqui isso erra o primeiro
			// item (index -1) e desloca todo clique para o anterior.
			const index = win.start + row;
			if (index >= 0 && index < rows.length) {
				setCursor(index);
				const target = rows[index];
				if (target) onOpen(target);
			}
		},
	});

	if (loading)
		return <Text color={theme.muted}>procurando serviços na máquina…</Text>;

	// Mesmo orçamento de linhas do caso com itens: o texto de boas-vindas ocupa
	// 4 linhas e num painel baixo estouraria o frame.
	if (rows.length === 0 && budget < 4)
		return <Text color={theme.muted}>nenhum serviço — n cria o primeiro</Text>;

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

	return (
		<Box flexDirection="column">
			{hasMoreAbove ? (
				<Text color={theme.muted}>▲ +{win.start} acima</Text>
			) : null}
			<Box ref={listRef} flexDirection="column">
				{visible.map((row, i) => (
					<Row
						key={row.name}
						row={row}
						width={columns}
						selected={win.start + i === cursor}
					/>
				))}
			</Box>
			{hasMoreBelow ? (
				<Text color={theme.muted}>▼ +{rows.length - win.end} abaixo</Text>
			) : null}
		</Box>
	);
}
