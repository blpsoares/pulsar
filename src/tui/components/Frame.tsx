import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { glyph, theme } from "../theme";

/**
 * Moldura comum a todas as telas: título em cima, conteúdo no meio, barra de
 * atalhos embaixo. Todas as telas usam isto para que a barra de ajuda esteja
 * sempre no mesmo lugar — a TUI é navegada por teclado, e o usuário precisa
 * saber quais teclas existem sem adivinhar.
 */

export type Hint = { keys: string; label: string };

export function Frame({
	title,
	subtitle,
	hints,
	children,
	status,
}: {
	title: string;
	subtitle?: string;
	hints: Hint[];
	children: ReactNode;
	status?: { text: string; tone?: "ok" | "warn" | "error" };
}) {
	return (
		<Box flexDirection="column" paddingX={1}>
			{/*
			 * flexShrink={0} no título: sem isso, uma linha mais larga que o
			 * terminal faz o yoga encolher CADA texto proporcionalmente, e o
			 * cabeçalho aparece como "pulsa · iníci". Quem pode ser cortado é o
			 * subtítulo (normalmente um caminho), e ele mora na própria linha.
			 */}
			<Box flexShrink={0}>
				<Text color={theme.accent} bold>
					pulsar
				</Text>
				<Text color={theme.muted}> · </Text>
				<Text bold>{title}</Text>
			</Box>
			{subtitle ? (
				<Box>
					<Text color={theme.muted} wrap="truncate-middle">
						{subtitle}
					</Text>
				</Box>
			) : null}

			<Box flexDirection="column" marginTop={1}>
				{children}
			</Box>

			{status ? (
				<Box marginTop={1}>
					<Text color={toneColor(status.tone)}>{status.text}</Text>
				</Box>
			) : null}

			<Box marginTop={1}>
				<Text color={theme.muted}>
					{hints.map((h, i) => (
						<Text key={h.keys}>
							{i > 0 ? "   " : ""}
							<Text bold color={theme.muted}>
								{h.keys}
							</Text>{" "}
							{h.label}
						</Text>
					))}
				</Text>
			</Box>
		</Box>
	);
}

function toneColor(tone?: "ok" | "warn" | "error"): string {
	if (tone === "ok") return theme.ok;
	if (tone === "warn") return theme.warn;
	if (tone === "error") return theme.error;
	return theme.muted;
}

/** Spinner de texto — usado enquanto conecta/estima, para a tela não parecer travada. */
export function Spinner({ frame, label }: { frame: number; label: string }) {
	const frames = glyph.spinner;
	return (
		<Text color={theme.accent}>
			{frames[frame % frames.length]} <Text color={theme.muted}>{label}</Text>
		</Text>
	);
}
