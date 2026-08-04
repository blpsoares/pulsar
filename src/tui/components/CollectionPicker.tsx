import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import {
	type CollEstimate,
	formatBytes,
	formatCount,
} from "../../core/inspect/collStats";
import type { CollIndexes } from "../../core/inspect/indexSummary";
import { type DbEntry, filterEntries } from "../../core/inspect/inspectDb";
import { useClickable } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, theme } from "../theme";
import { windowRange } from "./Select";

/**
 * Seletor de collections: busca incremental + multi-seleção + colunas de
 * números opcionais.
 *
 * As colunas de docs/tamanho/índices só aparecem quando as estimativas foram
 * carregadas — a tela nunca fica esperando número para poder ser usada. Quem
 * quer só marcar 3 collections e sair não paga nada por isso.
 */

export type StatColumns = {
	docs: boolean;
	size: boolean;
	indexes: boolean;
};

type Props = {
	entries: DbEntry[];
	selected: Set<string>;
	onToggle: (name: string) => void;
	onSelectAll: (names: string[]) => void;
	onClear: () => void;
	onConfirm: () => void;
	/** esc fora do modo busca — tratado AQUI, ver comentário no useInput */
	onBack: () => void;
	/** tecla `e` fora do modo busca */
	onOpenEstimates: () => void;
	/** contagem exata sob demanda da collection sob o cursor */
	onExactCount?: (name: string) => void;
	estimates: CollEstimate[];
	indexes: CollIndexes[];
	columns: StatColumns;
	focus?: boolean;
	visible?: number;
};

export function CollectionPicker({
	entries,
	selected,
	onToggle,
	onSelectAll,
	onClear,
	onConfirm,
	onBack,
	onOpenEstimates,
	onExactCount,
	estimates,
	indexes,
	columns,
	focus = true,
	visible = 12,
}: Props) {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const [searching, setSearching] = useState(false);

	const filtered = useMemo(
		() => filterEntries(entries, query),
		[entries, query],
	);
	const pos = Math.min(cursor, Math.max(0, filtered.length - 1));

	const estimateByName = useMemo(() => {
		const map = new Map<string, CollEstimate>();
		for (const e of estimates) map.set(e.name, e);
		return map;
	}, [estimates]);

	const indexByName = useMemo(() => {
		const map = new Map<string, CollIndexes>();
		for (const i of indexes) map.set(i.collection, i);
		return map;
	}, [indexes]);

	// TODAS as teclas desta tela são tratadas aqui, inclusive as que "pertencem"
	// ao passo (esc para voltar, `e` para o painel de estimativas). O ink entrega
	// cada tecla a todo `useInput` ativo: se o passo tivesse o próprio handler,
	// digitar "e" na busca abriria o painel e um esc para sair da busca também
	// voltaria de tela. Handler único é o que torna o modo busca possível.
	useInput(
		(input, key) => {
			// Sequência de mouse chega como texto pelo ink: sem esta guarda, um
			// clique durante a busca injetaria `[<0;10;5M` no termo procurado e a
			// lista esvaziaria sem explicação.
			if (isMouseInput(input)) return;
			// Modo busca: as teclas viram texto. Sem esse modo, digitar "a" para
			// procurar "accounts" selecionaria TODAS as collections.
			if (searching) {
				if (key.return || key.escape) {
					setSearching(false);
					return;
				}
				if (key.backspace || key.delete) {
					setQuery((q) => q.slice(0, -1));
					setCursor(0);
					return;
				}
				if (key.ctrl || key.meta || key.tab) return;
				if (input) {
					setQuery((q) => q + input);
					setCursor(0);
				}
				return;
			}

			if (key.escape) {
				onBack();
				return;
			}
			if (input === "/") {
				setSearching(true);
				return;
			}
			if (input === "e") {
				onOpenEstimates();
				return;
			}
			if (key.upArrow || input === "k") {
				setCursor(pos === 0 ? Math.max(0, filtered.length - 1) : pos - 1);
				return;
			}
			if (key.downArrow || input === "j") {
				setCursor(pos >= filtered.length - 1 ? 0 : pos + 1);
				return;
			}
			if (input === " ") {
				const item = filtered[pos];
				if (item) onToggle(item.name);
				return;
			}
			if (input === "a") {
				toggleAll();
				return;
			}
			if (input === "n") {
				onClear();
				return;
			}
			if (input === "c") {
				const item = filtered[pos];
				if (item) onExactCount?.(item.name);
				return;
			}
			if (key.return) onConfirm();
		},
		{ isActive: focus },
	);

	const { start, end } = windowRange(pos, filtered.length, visible);

	const allSelected =
		filtered.length > 0 && filtered.every((e) => selected.has(e.name));

	/**
	 * Controle explícito de "todas". A tecla `a` sempre existiu, mas ficava
	 * escondida no meio da barra de atalhos — quem não leu a barra marcava as
	 * collections uma por uma. Aqui ele é uma linha visível e clicável, e mostra
	 * o estado atual (todas marcadas ou não).
	 */
	const allRef = useClickable({
		onClick: () => toggleAll(),
	});

	function toggleAll() {
		if (allSelected) onClear();
		else onSelectAll(filtered.map((e) => e.name));
	}

	return (
		<Box flexDirection="column">
			<Box ref={allRef}>
				<Text color={allSelected ? theme.ok : theme.muted}>
					{allSelected ? glyph.boxChecked : glyph.boxUnchecked}
				</Text>
				<Text color={theme.label}>
					{" "}
					{query ? "marcar todas as filtradas" : "marcar todas"}
				</Text>
				<Text color={theme.border}> (a · n limpa · clique)</Text>
			</Box>
			<Box>
				<Text color={searching ? theme.accent : theme.muted}>busca: </Text>
				<Text>
					{query || (
						<Text color={theme.muted}>
							{searching ? "" : "tecle / para buscar"}
						</Text>
					)}
				</Text>
				{searching ? <Text inverse> </Text> : null}
				<Text color={theme.muted}>
					{"  "}
					{filtered.length}/{entries.length} listadas · {selected.size}{" "}
					selecionadas
				</Text>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				{filtered.length === 0 ? (
					<Text color={theme.muted}>
						{entries.length === 0
							? "nenhuma collection neste banco"
							: `nada com "${query}"`}
					</Text>
				) : (
					<>
						{start > 0 && <Text color={theme.muted}> ↑ {start} acima</Text>}
						{filtered.slice(start, end).map((entry, i) => (
							<Row
								key={entry.name}
								entry={entry}
								active={start + i === pos && !searching}
								checked={selected.has(entry.name)}
								estimate={estimateByName.get(entry.name)}
								indexInfo={indexByName.get(entry.name)}
								columns={columns}
							/>
						))}
						{end < filtered.length && (
							<Text color={theme.muted}> ↓ {filtered.length - end} abaixo</Text>
						)}
					</>
				)}
			</Box>
		</Box>
	);
}

function Row({
	entry,
	active,
	checked,
	estimate,
	indexInfo,
	columns,
}: {
	entry: DbEntry;
	active: boolean;
	checked: boolean;
	estimate?: CollEstimate;
	indexInfo?: CollIndexes;
	columns: StatColumns;
}) {
	const stats: string[] = [];

	if (columns.docs && estimate) {
		// O "~" é informação, não enfeite: diz que o número veio de metadata e
		// pode divergir do real. Sumir com ele seria mentir sobre a precisão.
		stats.push(
			`${estimate.exact ? "" : "~"}${formatCount(estimate.docs)} docs`,
		);
	}
	if (columns.size && estimate) stats.push(formatBytes(estimate.storageSize));
	if (columns.indexes && indexInfo)
		stats.push(`${indexInfo.secondaryCount} idx`);

	return (
		<Box>
			{/* mesmo motivo do Select: o nome da collection não pode encolher */}
			<Box flexShrink={0}>
				<Text color={active ? theme.selection : undefined}>
					{active ? `${glyph.cursor} ` : "  "}
					<Text color={checked ? theme.ok : theme.muted}>
						{checked ? glyph.checked : glyph.unchecked}
					</Text>{" "}
					<Text bold={active}>{entry.name}</Text>
				</Text>
			</Box>
			{stats.length > 0 ? (
				<Box flexShrink={1} marginLeft={2}>
					<Text color={theme.muted} wrap="truncate-end">
						{stats.join(" · ")}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
