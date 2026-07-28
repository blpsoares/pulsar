import { Text, useInput } from "ink";
import { useState } from "react";
import { theme } from "../theme";

/**
 * Campo de texto controlado.
 *
 * Escrito à mão em vez de usar `ink-text-input` porque aquele pacote declara
 * peer em ink ^5 e este projeto está no ink 7 — e o que precisamos daqui é
 * pequeno o bastante para não valer a incompatibilidade.
 *
 * Detalhe que importa: `input` do ink pode chegar com VÁRIOS caracteres de uma
 * vez (colar uma connection string manda a string inteira num evento só). Por
 * isso o texto é inserido como bloco, nunca char a char.
 */

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	/** só reage a teclas quando focado */
	focus?: boolean;
	placeholder?: string;
	/** esconde o valor (usado em nada hoje; útil se um dia pedir senha isolada) */
	mask?: boolean;
};

export function TextInput({
	value,
	onChange,
	onSubmit,
	focus = true,
	placeholder = "",
	mask = false,
}: Props) {
	const [cursor, setCursor] = useState(value.length);
	const pos = Math.min(cursor, value.length);

	useInput(
		(input, key) => {
			if (key.return) {
				onSubmit?.(value);
				return;
			}
			if (key.leftArrow) {
				setCursor(Math.max(0, pos - 1));
				return;
			}
			if (key.rightArrow) {
				setCursor(Math.min(value.length, pos + 1));
				return;
			}
			if (key.backspace || key.delete) {
				if (pos === 0) return;
				onChange(value.slice(0, pos - 1) + value.slice(pos));
				setCursor(pos - 1);
				return;
			}
			// Teclas de controle não viram texto. Sem isso, um Tab ou uma seta
			// não tratada injetaria caracteres invisíveis na URI.
			if (
				key.ctrl ||
				key.meta ||
				key.escape ||
				key.tab ||
				key.upArrow ||
				key.downArrow
			)
				return;
			if (!input) return;

			onChange(value.slice(0, pos) + input + value.slice(pos));
			setCursor(pos + input.length);
		},
		{ isActive: focus },
	);

	if (!value) {
		return (
			<Text color={theme.muted}>
				{focus ? <Text inverse> </Text> : " "}
				{placeholder}
			</Text>
		);
	}

	const shown = mask ? "•".repeat(value.length) : value;

	if (!focus) return <Text>{shown}</Text>;

	// Cursor renderizado como bloco invertido sobre o caractere atual.
	const before = shown.slice(0, pos);
	const at = shown.slice(pos, pos + 1) || " ";
	const after = shown.slice(pos + 1);

	return (
		<Text>
			{before}
			<Text inverse>{at}</Text>
			{after}
		</Text>
	);
}
