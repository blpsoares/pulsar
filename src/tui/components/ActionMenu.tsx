import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useClickable } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, theme } from "../theme";

/**
 * Menu de ações do item selecionado, aberto sobre o painel.
 *
 * As ações vivem AQUI, junto do item, e não numa barra lateral de verbos. Com
 * os verbos à esquerda era preciso primeiro deixar a config certa selecionada
 * na lista e só depois escolher o verbo — duas etapas separadas na tela, sem
 * nada ligando uma à outra. Agora é enter (ou clique) no arquivo e as ações
 * daquele arquivo aparecem.
 */

export type Action = {
	key: string;
	label: string;
	hint?: string;
	/** ação indisponível agora (ex.: parar um serviço que não está no ar) */
	disabled?: boolean;
	/** destaca em amarelo: mexe no sistema (instala serviço, remove) */
	warn?: boolean;
};

export function ActionMenu({
	title,
	actions,
	onPick,
	onClose,
	width,
}: {
	title: string;
	actions: Action[];
	onPick: (key: string) => void;
	onClose: () => void;
	width: number;
}) {
	const [cursor, setCursor] = useState(0);
	const enabled = actions.filter((a) => !a.disabled);

	const ref = useClickable({
		onClick: ({ row }) => {
			// linha 0 é o título; 1 em diante são as ações
			const action = actions[row - 1];
			if (!action || action.disabled) return;
			onPick(action.key);
		},
	});

	useInput((input, key) => {
		if (isMouseInput(input)) return;

		if (key.escape) {
			onClose();
			return;
		}
		if (key.upArrow) {
			setCursor((c) => (c === 0 ? actions.length - 1 : c - 1));
			return;
		}
		if (key.downArrow) {
			setCursor((c) => (c === actions.length - 1 ? 0 : c + 1));
			return;
		}
		if (key.return) {
			const action = actions[cursor];
			if (action && !action.disabled) onPick(action.key);
			return;
		}
		// Atalho direto pela letra da ação — quem já sabe não precisa navegar.
		const direct = enabled.find((a) => a.key === input);
		if (direct) onPick(direct.key);
	});

	return (
		<Box flexDirection="column" ref={ref}>
			<Text color={theme.accent} bold wrap="truncate-end">
				{title}
			</Text>
			{actions.map((action, i) => {
				const active = i === cursor && !action.disabled;
				return (
					<Box key={action.key}>
						<Box flexShrink={0}>
							<Text
								color={
									action.disabled
										? theme.border
										: active
											? theme.selection
											: action.warn
												? theme.warn
												: undefined
								}
								bold={active}
								wrap="truncate-end"
							>
								{active ? `${glyph.cursor} ` : "  "}
								<Text color={theme.border}>[{action.key}]</Text> {action.label}
							</Text>
						</Box>
						{action.hint ? (
							<Box flexShrink={1} marginLeft={2}>
								<Text
									color={action.disabled ? theme.border : theme.muted}
									wrap="truncate-end"
								>
									{action.hint}
								</Text>
							</Box>
						) : null}
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme.muted} wrap="truncate-end">
					enter escolhe · esc fecha · ou tecle a letra
				</Text>
			</Box>
		</Box>
	);
}
