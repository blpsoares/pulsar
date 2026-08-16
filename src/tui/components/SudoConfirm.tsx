import { Box, Text } from "ink";
import type { ServiceStep } from "../../core/service/types";
import { theme } from "../theme";
import { Overlay } from "./Overlay";

/**
 * "Vou rodar isto, que pede senha" — o overlay que aparece no ponto EXATO em
 * que a instalação precisa de root.
 *
 * Existe em um lugar só porque o contrato tem que ser o mesmo nos dois lugares
 * que pedem sudo (criar serviço, no formulário; ligar o boot depois ou trocar
 * de backend, pelo detalhe): mostrar o comando LITERAL antes de rodar, `enter`
 * entrega o terminal ao sudo, `p` pula — e pular não faz a operação falhar.
 * Duas cópias do mesmo modal divergem no dia em que uma ganhar um aviso novo.
 *
 * Só desenha; quem escuta o teclado é a tela dona da operação, porque é ela
 * que tem a Promise para resolver.
 */
export function SudoConfirm({
	step,
	columns,
	rows,
}: {
	step: ServiceStep;
	columns: number;
	rows: number;
}) {
	return (
		<Overlay title="confirmar comando" columns={columns} rows={rows}>
			<Text color={theme.muted} wrap="wrap">
				vou rodar (pede senha):
			</Text>
			<Text color={theme.label} wrap="wrap">
				{step.cmd} {step.args.join(" ")}
			</Text>
			<Text color={theme.muted} wrap="wrap">
				{step.why}
			</Text>
			<Box marginTop={1}>
				<Text>
					<Text color={theme.accent} bold>
						enter
					</Text>
					<Text color={theme.muted}> digitar a senha agora · </Text>
					<Text color={theme.accent} bold>
						p
					</Text>
					<Text color={theme.muted}> pular</Text>
				</Text>
			</Box>
		</Overlay>
	);
}
