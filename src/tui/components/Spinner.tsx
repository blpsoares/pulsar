import { Text } from "ink";
import { glyph, theme } from "../theme";

/** Spinner de texto — usado enquanto conecta/estima, para a tela não parecer travada. */
export function Spinner({ frame, label }: { frame: number; label: string }) {
	return (
		<Text color={theme.accent}>
			{glyph.spinner[frame % glyph.spinner.length]}{" "}
			<Text color={theme.muted}>{label}</Text>
		</Text>
	);
}
