import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { glyph, theme } from "../../theme";

/**
 * Painel "show estimatives": liga/desliga a coleta de números e escolhe QUAIS
 * métricas puxar.
 *
 * É opt-in porque cada métrica marcada custa uma rodada de comandos por
 * collection (um `$collStats` e/ou um `listIndexes` para cada uma). Num banco
 * com 200 collections isso são centenas de idas ao cluster — aceitável quando
 * o usuário pediu, indefensável como comportamento automático ao abrir a tela.
 */

export type EstimateOptions = {
	enabled: boolean;
	docs: boolean;
	size: boolean;
	indexes: boolean;
};

export const DEFAULT_ESTIMATE_OPTIONS: EstimateOptions = {
	enabled: false,
	docs: true,
	size: true,
	indexes: false,
};

const ROWS: { key: keyof EstimateOptions; label: string; hint: string }[] = [
	{
		key: "enabled",
		label: "show estimatives",
		hint: "liga a coleta de números",
	},
	{ key: "docs", label: "documentos", hint: "$collStats — aproximado" },
	{ key: "size", label: "tamanho em disco", hint: "$collStats" },
	{
		key: "indexes",
		label: "índices",
		hint: "listIndexes por collection — mais lento",
	},
];

export function EstimatesPanel({
	options,
	onChange,
	onClose,
	focus = true,
	loading = false,
}: {
	options: EstimateOptions;
	onChange: (next: EstimateOptions) => void;
	onClose: () => void;
	focus?: boolean;
	loading?: boolean;
}) {
	const [cursor, setCursor] = useState(0);

	useInput(
		(input, key) => {
			if (key.escape || key.return) {
				onClose();
				return;
			}
			if (key.upArrow) {
				setCursor((c) => (c === 0 ? ROWS.length - 1 : c - 1));
				return;
			}
			if (key.downArrow) {
				setCursor((c) => (c === ROWS.length - 1 ? 0 : c + 1));
				return;
			}
			if (input === " ") {
				const row = ROWS[cursor];
				if (!row) return;
				const next = { ...options, [row.key]: !options[row.key] };
				// Marcar uma métrica com o painel desligado não faria nada visível;
				// ligar junto é o que o usuário quis dizer.
				if (row.key !== "enabled" && next[row.key]) next.enabled = true;
				onChange(next);
			}
		},
		{ isActive: focus },
	);

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.muted}
			paddingX={1}
		>
			<Text color={theme.accent} bold>
				estimativas
			</Text>
			{ROWS.map((row, i) => {
				const active = i === cursor;
				const on = options[row.key];
				const dim = row.key !== "enabled" && !options.enabled;
				return (
					<Box key={row.key}>
						<Text color={active ? theme.selection : undefined}>
							{active ? `${glyph.cursor} ` : "  "}
							<Text color={on ? theme.ok : theme.muted}>
								{on ? glyph.boxChecked : glyph.boxUnchecked}
							</Text>{" "}
							<Text
								color={dim ? theme.muted : undefined}
								bold={row.key === "enabled"}
							>
								{row.label}
							</Text>
						</Text>
						<Text color={theme.muted}>
							{"  "}
							{row.hint}
						</Text>
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme.muted}>
					{loading ? "carregando…" : "espaço marca · enter/esc fecha"}
				</Text>
			</Box>
		</Box>
	);
}
