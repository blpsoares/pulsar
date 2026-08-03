import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { useClickable } from "../mouse/MouseProvider";
import { glyph, theme } from "../theme";
import { SearchField } from "./SearchField";
import { windowRange } from "./Select";

/**
 * Lista marcável com busca — a peça comum aos passos de views e de índices.
 *
 * Não é o `CollectionPicker`: aquele carrega colunas de estimativa, contagem
 * exata sob demanda e o painel de números, coisas que só fazem sentido para
 * collections. Aqui a lista é de METADADO (nomes de view, nomes de índice), que
 * não tem tamanho para estimar — juntar os dois num componente só faria um
 * componente com metade dos parâmetros ignorados em cada uso.
 */

export type PickerItem = {
	/** identidade — é o que volta em onToggle e o que a busca casa */
	id: string;
	label: string;
	/** texto secundário na mesma linha (base da view, campos do índice…) */
	hint?: string;
	/** marcador extra à direita (único, TTL…) */
	tag?: string;
	/** linha em destaque de aviso (view órfã, por exemplo) */
	warn?: boolean;
};

export function EntryPicker({
	items,
	selected,
	onToggle,
	onSelectAll,
	onClear,
	onConfirm,
	onBack,
	focus = true,
	visible = 12,
	emptyLabel = "nada para escolher",
	allLabel = "marcar todos",
}: {
	items: PickerItem[];
	selected: Set<string>;
	onToggle: (id: string) => void;
	onSelectAll: (ids: string[]) => void;
	onClear: () => void;
	onConfirm: () => void;
	onBack: () => void;
	focus?: boolean;
	visible?: number;
	emptyLabel?: string;
	allLabel?: string;
}) {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const [searching, setSearching] = useState(false);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return items;
		return items.filter(
			(i) =>
				i.label.toLowerCase().includes(needle) ||
				i.hint?.toLowerCase().includes(needle),
		);
	}, [items, query]);

	const pos = Math.min(cursor, Math.max(0, filtered.length - 1));
	const allSelected =
		filtered.length > 0 && filtered.every((i) => selected.has(i.id));

	function toggleAll() {
		if (allSelected) onClear();
		else onSelectAll(filtered.map((i) => i.id));
	}

	// Handler único, pela mesma razão do CollectionPicker: com o modo busca
	// ligado, cada tecla é TEXTO — um segundo useInput no passo roubaria letras
	// da busca (digitar "n" limparia a seleção no meio da palavra).
	useInput(
		(input, key) => {
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
				if (item) onToggle(item.id);
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
			if (key.return) onConfirm();
		},
		{ isActive: focus },
	);

	const { start, end } = windowRange(pos, filtered.length, visible);

	const allRef = useClickable({ onClick: () => toggleAll() });
	const listRef = useClickable({
		onClick: ({ row }) => {
			const offset = start > 0 ? 1 : 0; // linha "↑ N acima"
			const item = filtered[start + row - offset];
			if (item) onToggle(item.id);
		},
		onWheel: (direction) => {
			if (filtered.length === 0) return;
			setCursor(
				Math.max(0, Math.min(filtered.length - 1, pos + direction * 3)),
			);
		},
	});

	return (
		<Box flexDirection="column">
			<Box ref={allRef}>
				<Text color={allSelected ? theme.ok : theme.muted}>
					{allSelected ? glyph.boxChecked : glyph.boxUnchecked}
				</Text>
				<Text color={theme.label}>
					{" "}
					{query ? `${allLabel} (filtrados)` : allLabel}
				</Text>
				<Text color={theme.border}> (a · n limpa · clique)</Text>
			</Box>

			<SearchField
				query={query}
				active={searching}
				onActivate={() => setSearching(true)}
				summary={`${filtered.length}/${items.length} · ${selected.size} marcados`}
			/>

			<Box flexDirection="column" marginTop={1} ref={listRef}>
				{filtered.length === 0 ? (
					<Text color={theme.muted}>
						{items.length === 0 ? emptyLabel : `nada com "${query}"`}
					</Text>
				) : (
					<>
						{start > 0 && <Text color={theme.muted}> ↑ {start} acima</Text>}
						{filtered.slice(start, end).map((item, i) => {
							const active = start + i === pos && !searching;
							const checked = selected.has(item.id);
							return (
								<Box key={item.id}>
									<Text color={active ? theme.selection : undefined}>
										{active ? `${glyph.cursor} ` : "  "}
									</Text>
									<Text color={checked ? theme.ok : theme.muted}>
										{checked ? glyph.checked : glyph.unchecked}{" "}
									</Text>
									<Text
										bold={active}
										color={item.warn ? theme.warn : undefined}
									>
										{item.label}
									</Text>
									{item.tag ? (
										<Text color={theme.accent}> {item.tag}</Text>
									) : null}
									{item.hint ? (
										<Text color={theme.muted} wrap="truncate-end">
											{"  "}
											{item.hint}
										</Text>
									) : null}
								</Box>
							);
						})}
						{end < filtered.length && (
							<Text color={theme.muted}> ↓ {filtered.length - end} abaixo</Text>
						)}
					</>
				)}
			</Box>
		</Box>
	);
}
