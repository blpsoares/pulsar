import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { glyph, theme } from "../../theme";

/**
 * Opções de "show estimatives": liga/desliga a coleta de números e escolhe
 * QUAIS métricas puxar.
 *
 * Mora na sidebar, sempre visível — não é um modal. Assim o usuário vê o que
 * está ligado enquanto navega na lista, em vez de abrir uma janela para
 * lembrar.
 *
 * É opt-in porque cada métrica marcada custa uma rodada de comandos por
 * collection. Num banco com 200 collections são centenas de idas ao cluster:
 * aceitável quando pedido, indefensável ao abrir a tela.
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

const ROWS: { key: keyof EstimateOptions; label: string }[] = [
	{ key: "enabled", label: "estimativas" },
	{ key: "docs", label: "documentos" },
	{ key: "size", label: "tamanho" },
	{ key: "indexes", label: "índices" },
];

export function EstimatesOptions({
	options,
	onChange,
	onClose,
	focused,
	loading = false,
}: {
	options: EstimateOptions;
	onChange: (next: EstimateOptions) => void;
	onClose: () => void;
	focused: boolean;
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
				// Marcar uma métrica com a coleta desligada não faria nada visível;
				// ligar junto é o que o usuário quis dizer.
				if (row.key !== "enabled" && next[row.key]) next.enabled = true;
				onChange(next);
			}
		},
		{ isActive: focused },
	);

	return (
		<Box flexDirection="column">
			{ROWS.map((row, i) => {
				const active = focused && i === cursor;
				const on = options[row.key];
				const dim = row.key !== "enabled" && !options.enabled;
				return (
					<Text
						key={row.key}
						color={active ? theme.selection : dim ? theme.border : undefined}
					>
						{active ? "▍" : " "}
						<Text color={on ? theme.ok : theme.muted}>
							{on ? glyph.checked : glyph.unchecked}
						</Text>{" "}
						<Text bold={row.key === "enabled"}>{row.label}</Text>
					</Text>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme.muted} wrap="wrap">
					{loading
						? "carregando…"
						: focused
							? "espaço marca · esc volta"
							: "e para editar"}
				</Text>
			</Box>
		</Box>
	);
}
