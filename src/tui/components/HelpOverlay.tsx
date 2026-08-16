import { Text, useInput } from "ink";
import { useState } from "react";
import { helpFor, type KeyContext, type Layer } from "../keys";
import { overlayBox } from "../layout";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";
import { Overlay } from "./Overlay";

/**
 * A ajuda é CONTEXTUAL: mostra as teclas da camada em que a pessoa está, com
 * as globais no fim. Um help único listando tudo de todas as telas é o tipo de
 * coisa que ninguém lê duas vezes.
 */

const TITLES: Record<Layer, string> = {
	list: "serviços",
	detail: "serviço",
	form: "formulário",
	logs: "logs",
	switch: "trocar inicialização",
	help: "ajuda",
};

type HelpLine =
	| { kind: "group"; text: string }
	| { kind: "key"; keys: string; label: string }
	| { kind: "blank" };

/**
 * Achata os grupos em LINHAS antes de desenhar.
 *
 * Sem isso não há como saber quantas linhas a ajuda ocupa, e o `Box` do ink
 * não recorta o próprio conteúdo: desenhar mais linhas do que cabem não corta
 * a saída, CORROMPE o frame (o mesmo perigo que `listWindow` resolve na lista
 * e no formulário). A ajuda da camada de logs tem 4 grupos e 15 teclas — mais
 * de 20 linhas — e estourava a caixa em qualquer terminal de 20 a 30 linhas.
 */
export function helpLines(
	layer: Layer,
	ctx: KeyContext,
	compact: boolean,
): HelpLine[] {
	const lines: HelpLine[] = [];

	for (const group of helpFor(layer, ctx)) {
		// A linha em branco entre grupos é a primeira coisa a cair quando falta
		// altura: ela separa, não informa.
		if (!compact && lines.length > 0) lines.push({ kind: "blank" });
		lines.push({ kind: "group", text: group.group });
		for (const binding of group.keys)
			lines.push({ kind: "key", keys: binding.keys, label: binding.label });
	}

	return lines;
}

/**
 * Que fatia das linhas cabe na caixa, e se sobra coisa fora dela.
 *
 * Pura porque é ela que impede a corrupção de frame — e o jeito de provar que
 * NUNCA se desenha mais linha do que cabe é asserção, não olhar para a tela:
 * `(end - start) + (overflow ? 1 : 0) <= usable`, sempre.
 */
export function helpWindow(
	total: number,
	usable: number,
	offset: number,
): { start: number; end: number; overflow: boolean } {
	const room = Math.max(1, usable);
	// `overflow` significa "o indicador VAI ser desenhado", porque ele também
	// ocupa linha: com uma linha só de espaço, gastá-la no aviso não deixaria
	// nada de ajuda na tela.
	const overflow = total > room && room >= 2;
	const height = Math.max(1, overflow ? room - 1 : room);
	const start = Math.max(0, Math.min(Math.max(0, total - height), offset));
	return { start, end: Math.min(total, start + height), overflow };
}

export function HelpOverlay({
	layer,
	columns,
	rows,
	context = {},
	enabled = true,
}: {
	layer: Layer;
	columns: number;
	rows: number;
	/**
	 * Estado do objeto em foco — sem isto a ajuda do detalhe anunciaria `a`
	 * (adotar) para todo serviço e `o` (ligar boot) para quem já sobe no boot.
	 */
	context?: KeyContext;
	/** false quando a ajuda não é a camada do topo (não acontece hoje) */
	enabled?: boolean;
}) {
	const [offset, setOffset] = useState(0);

	const box = overlayBox(columns, rows);
	// -1 da linha de título, -1 da borda de baixo.
	const usable = Math.max(1, box.height - 2);

	// Duas passadas: só aperta os espaços entre grupos se a versão arejada não
	// couber. Um help de 6 linhas não precisa ficar feio por causa de um de 23.
	const spaced = helpLines(layer, context, false);
	const lines =
		spaced.length <= usable ? spaced : helpLines(layer, context, true);

	const { start, end, overflow } = helpWindow(lines.length, usable, offset);
	const height = end - start;
	const scrollable = end - start < lines.length;
	const maxOffset = Math.max(0, lines.length - height);
	const visible = lines.slice(start, end);

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!scrollable) return;
			if (key.upArrow) setOffset(Math.max(0, start - 1));
			if (key.downArrow) setOffset(Math.min(maxOffset, start + 1));
			if (key.pageUp) setOffset(Math.max(0, start - height));
			if (key.pageDown) setOffset(Math.min(maxOffset, start + height));
		},
		{ isActive: enabled },
	);

	return (
		<Overlay title={`teclas · ${TITLES[layer]}`} columns={columns} rows={rows}>
			{visible.map((line, i) =>
				line.kind === "blank" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: linha em branco é posicional
					<Text key={`b${i}`}> </Text>
				) : line.kind === "group" ? (
					<Text key={`g${line.text}`} color={theme.muted}>
						{line.text}
					</Text>
				) : (
					<Text key={`k${line.keys}`} wrap="truncate-end">
						{"  "}
						<Text color={theme.accent} bold>
							{line.keys.padEnd(12)}
						</Text>
						<Text color={theme.label}>{line.label}</Text>
					</Text>
				),
			)}
			{overflow ? (
				<Text color={theme.muted} wrap="truncate-end">
					{end < lines.length
						? `▼ +${lines.length - end} abaixo · ↑↓ rola`
						: "▲ topo com ↑"}
				</Text>
			) : null}
		</Overlay>
	);
}
