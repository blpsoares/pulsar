import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { overlayBox } from "../layout";
import { theme } from "../theme";

/**
 * Caixa flutuante desenhada POR CIMA da tela raiz.
 *
 * `position="absolute"` tira a caixa do fluxo do Yoga, então a lista de baixo
 * não é empurrada — ela continua desenhada e o overlay sobrescreve as células
 * que ocupa. É o que dá a sensação de camada, e é por isso que `esc` devolve o
 * cursor exatamente onde estava: a lista nunca desmontou.
 */
export function Overlay({
	title,
	columns,
	rows,
	footer,
	children,
}: {
	title: string;
	columns: number;
	rows: number;
	footer?: ReactNode;
	children: ReactNode;
}) {
	const box = overlayBox(columns, rows);

	return (
		<Box
			position="absolute"
			marginLeft={box.marginLeft}
			marginTop={box.marginTop}
			width={box.width}
			height={box.height}
			flexDirection="column"
		>
			{/*
			 * Fundo OPACO. O ink só pinta as células em que algum `Text` escreve —
			 * o vão entre a borda e o texto (o `paddingX`) e o resto de uma linha
			 * curta ficam transparentes, e a lista de baixo aparece dentro do
			 * overlay, letra sim letra não. Uma camada de espaços da largura da
			 * caixa apaga isso: é o equivalente a limpar a região antes de desenhar
			 * a janela.
			 */}
			<Box position="absolute" flexDirection="column">
				{Array.from({ length: box.height }, (_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: linhas de fundo são posicionais
					<Text key={i}>{" ".repeat(box.width)}</Text>
				))}
			</Box>
			<Text color={theme.accent}>
				╭─<Text bold>{` ${title} `}</Text>
				{"─".repeat(Math.max(0, box.width - title.length - 5))}╮
			</Text>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderTop={false}
				borderColor={theme.accent}
				paddingX={1}
				flexGrow={1}
			>
				<Box flexDirection="column" flexGrow={1}>
					{children}
				</Box>
				{footer ? <Box marginTop={1}>{footer}</Box> : null}
			</Box>
		</Box>
	);
}
