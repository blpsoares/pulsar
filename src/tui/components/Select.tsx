import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { glyph, theme } from "../theme";

/**
 * Lista de escolha única com janela deslizante.
 *
 * A janela (`visible`) existe porque a alternativa — renderizar as 200
 * collections de uma vez — faz o ink reescrever a tela inteira a cada tecla e
 * o terminal engasgar visivelmente. Aqui só as ~10 linhas visíveis são
 * desenhadas, independente do tamanho da lista.
 */

export type SelectItem<T> = {
	value: T;
	label: string;
	/** texto secundário à direita (ex.: destino de um yml, tamanho de uma coll) */
	hint?: string;
	disabled?: boolean;
};

type Props<T> = {
	items: SelectItem<T>[];
	onSelect: (value: T, index: number) => void;
	/**
	 * Chamado quando o cursor PARA sobre um item (sem confirmar). Serve para
	 * pré-visualizar o item destacado — ex.: o resumo do banco sob o cursor,
	 * antes de escolhê-lo.
	 */
	onHighlight?: (value: T, index: number) => void;
	focus?: boolean;
	visible?: number;
	/** índice inicial do cursor */
	initialIndex?: number;
	emptyMessage?: string;
};

export function Select<T>({
	items,
	onSelect,
	onHighlight,
	focus = true,
	visible = 10,
	initialIndex = 0,
	emptyMessage = "nada aqui",
}: Props<T>) {
	const [index, setIndex] = useState(
		Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)),
	);

	// A lista pode encolher (filtro de busca) e deixar o cursor fora do range.
	const cursor = Math.min(index, Math.max(0, items.length - 1));

	// Dispara o preview do item destacado, inclusive do inicial. `onHighlight`
	// costuma fazer I/O, então o efeito depende só do valor sob o cursor — não
	// do array de itens, que é recriado a cada render.
	const current = items[cursor];
	// biome-ignore lint/correctness/useExhaustiveDependencies: `current` representa o item; items muda de identidade a cada render
	useEffect(() => {
		if (current && !current.disabled) onHighlight?.(current.value, cursor);
	}, [current?.label, cursor, onHighlight]);

	useInput(
		(input, key) => {
			if (items.length === 0) return;

			if (key.upArrow || input === "k") {
				setIndex(cursor === 0 ? items.length - 1 : cursor - 1);
				return;
			}
			if (key.downArrow || input === "j") {
				setIndex(cursor === items.length - 1 ? 0 : cursor + 1);
				return;
			}
			if (key.return) {
				const item = items[cursor];
				if (item && !item.disabled) onSelect(item.value, cursor);
			}
		},
		{ isActive: focus },
	);

	if (items.length === 0)
		return <Text color={theme.muted}>{emptyMessage}</Text>;

	const { start, end } = windowRange(cursor, items.length, visible);

	return (
		<Box flexDirection="column">
			{start > 0 && <Text color={theme.muted}> ↑ {start} acima</Text>}
			{items.slice(start, end).map((item, i) => {
				const active = start + i === cursor;
				return (
					// flexShrink só existe em Box (o Text do ink não aceita): o rótulo
					// fica travado e a dica é quem encolhe/trunca quando a linha não
					// cabe. Sem isso o ink come letras do NOME do item.
					<Box key={item.label}>
						<Box flexShrink={0}>
							<Text color={active ? theme.selection : undefined}>
								{active ? `${glyph.cursor} ` : "  "}
								<Text
									color={
										item.disabled
											? theme.muted
											: active
												? theme.selection
												: undefined
									}
									bold={active}
								>
									{item.label}
								</Text>
							</Text>
						</Box>
						{item.hint ? (
							<Box flexShrink={1} marginLeft={2}>
								<Text color={theme.muted} wrap="truncate-end">
									{item.hint}
								</Text>
							</Box>
						) : null}
					</Box>
				);
			})}
			{end < items.length && (
				<Text color={theme.muted}> ↓ {items.length - end} abaixo</Text>
			)}
		</Box>
	);
}

/**
 * Mantém o cursor dentro da janela sem fazer a lista "pular": a janela só anda
 * quando o cursor encosta na borda.
 */
export function windowRange(
	cursor: number,
	total: number,
	visible: number,
): { start: number; end: number } {
	if (total <= visible) return { start: 0, end: total };
	const half = Math.floor(visible / 2);
	let start = Math.max(0, cursor - half);
	const end = Math.min(total, start + visible);
	start = Math.max(0, end - visible);
	return { start, end };
}
