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
