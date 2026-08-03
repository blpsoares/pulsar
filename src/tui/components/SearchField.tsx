import { Box, Text } from "ink";
import { useClickable } from "../mouse/MouseProvider";
import { theme } from "../theme";

/**
 * O campo de busca das listas — o MESMO em collections, views e índices.
 *
 * Antes a busca era uma linha de texto discreta ("busca: tecle / para buscar")
 * no meio do painel: existia, funcionava e passava despercebida — quem chegava
 * numa lista de 200 collections rolava tudo na seta achando que buscar não era
 * possível. Aqui ela tem moldura, cursor quando ativa, e é CLICÁVEL: dá para
 * cair na busca sem saber que a tecla é `/`.
 *
 * Quem digita continua sendo o dono da lista (o handler de teclas do picker),
 * porque as letras precisam servir de atalho quando a busca está desligada —
 * este componente é só a moldura e o estado visível.
 */
export function SearchField({
	query,
	active,
	onActivate,
	summary,
}: {
	query: string;
	active: boolean;
	onActivate: () => void;
	/** contagem à direita: "12/40 · 3 marcados" */
	summary?: string;
}) {
	const ref = useClickable({ onClick: onActivate });

	return (
		<Box ref={ref}>
			<Text color={active ? theme.accent : theme.border}>
				{active ? "▸ " : "  "}
			</Text>
			<Text color={active ? theme.accent : theme.muted}>buscar </Text>
			<Text color={theme.border}>[</Text>
			<Text color={query ? theme.label : theme.muted}>
				{query || (active ? "" : "clique ou / para buscar")}
			</Text>
			{active ? <Text inverse> </Text> : null}
			<Text color={theme.border}>]</Text>
			{summary ? <Text color={theme.muted}> {summary}</Text> : null}
		</Box>
	);
}
