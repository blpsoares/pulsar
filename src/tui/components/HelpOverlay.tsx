import { Box, Text } from "ink";
import { helpFor, type Layer } from "../keys";
import { theme } from "../theme";
import { Overlay } from "./Overlay";

/**
 * A ajuda é CONTEXTUAL: mostra as teclas da camada em que a pessoa está, com
 * as globais no fim. Um help único listando tudo de todas as telas é o tipo de
 * coisa que ninguém lê duas vezes.
 */
export function HelpOverlay({
	layer,
	columns,
	rows,
}: {
	layer: Layer;
	columns: number;
	rows: number;
}) {
	const titles: Record<Layer, string> = {
		list: "serviços",
		detail: "serviço",
		form: "formulário",
		logs: "logs",
		help: "ajuda",
	};

	return (
		<Overlay title={`teclas · ${titles[layer]}`} columns={columns} rows={rows}>
			{helpFor(layer).map((group) => (
				<Box key={group.group} flexDirection="column" marginBottom={1}>
					<Text color={theme.muted}>{group.group}</Text>
					{group.keys.map((binding) => (
						<Text key={binding.keys} wrap="truncate-end">
							{"  "}
							<Text color={theme.accent} bold>
								{binding.keys.padEnd(12)}
							</Text>
							<Text color={theme.label}>{binding.label}</Text>
						</Text>
					))}
				</Box>
			))}
		</Overlay>
	);
}
