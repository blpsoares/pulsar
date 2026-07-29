import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { formatBytes } from "../../../core/inspect/collStats";
import { maskUri } from "../../../core/inspect/maskUri";
import { Select } from "../../components/Select";
import { Spinner } from "../../components/Spinner";
import { TextInput } from "../../components/TextInput";
import type { useInspector } from "../../hooks/useInspector";
import { useSpinner } from "../../hooks/useSpinner";
import { theme } from "../../theme";

/**
 * Passo de conexão (serve tanto para origem quanto para destino).
 *
 * O fluxo é deliberadamente "conecte primeiro, escolha depois": só depois de
 * uma conexão real conseguimos listar os bancos e, na origem, as collections.
 * Digitar o nome do banco às cegas é a principal fonte de yml que só falha na
 * hora de rodar — um typo em `db:` só apareceria minutos depois.
 *
 * Quando o usuário não tem permissão de listar bancos (o caso comum de um user
 * de aplicação no Atlas), o campo vira texto livre em vez de travar o wizard.
 */

type Props = {
	kind: "source" | "destination";
	uri: string;
	db: string;
	onChange: (value: { uri: string; db: string }) => void;
	inspector: ReturnType<typeof useInspector>;
	/** chamado quando o banco foi confirmado e o passo pode avançar */
	onDone: () => void;
	onBack: () => void;
	/** false quando o foco está no trilho de passos */
	focused: boolean;
};

type Field = "uri" | "db";

/** Valor sentinela do item "digitar outro nome" na lista de bancos. */
const TYPE_NEW = "\u0000novo";

export function ConnectionStep({
	kind,
	uri,
	db,
	onChange,
	inspector,
	onDone,
	onBack,
	focused,
}: Props) {
	const [field, setField] = useState<Field>("uri");
	/**
	 * Banco por DIGITAÇÃO em vez de escolha na lista. Serve para dois casos
	 * reais: o destino que ainda não existe (o Mongo cria na primeira escrita) e
	 * a origem cujo usuário não tem permissão de listar bancos, mas sabe o nome.
	 */
	const [typing, setTyping] = useState(false);
	// Evita recarregar o mesmo banco a cada render enquanto o cursor não anda.
	const previewed = useRef<string | null>(null);
	const { state, connect, loadDb } = inspector;
	const connecting = state.status === "connecting";
	const frame = useSpinner(connecting);

	const canListDbs = state.status === "connected" && state.databases.length > 0;

	useInput(
		(_input, key) => {
			if (key.escape) {
				if (typing) {
					setTyping(false);
					return;
				}
				onBack();
				return;
			}
			// Tab volta para a URI para corrigir sem refazer o passo.
			if (key.tab && state.status === "connected") {
				setField((f) => (f === "uri" ? "db" : "uri"));
			}
		},
		{ isActive: !connecting && focused },
	);

	async function handleUriSubmit(value: string) {
		const ok = await connect(value);
		if (ok) setField("db");
	}

	/**
	 * Preview do banco sob o cursor: carrega collections/views/estatísticas sem
	 * confirmar a escolha. É o que faz o painel da direita responder enquanto se
	 * navega pela lista, em vez de só depois de escolher.
	 */
	function handleDbHighlight(name: string) {
		if (!name || name === previewed.current) return;
		previewed.current = name;
		void loadDb(name);
	}

	async function handleDbConfirm(name: string) {
		const clean = name.trim();
		if (!clean) return;
		onChange({ uri, db: clean });
		if (kind === "source") await loadDb(clean);
		onDone();
	}

	return (
		<Box flexDirection="column">
			<Text color={theme.muted}>
				{kind === "source"
					? "De onde os dados saem."
					: "Para onde os dados vão. Este banco recebe escrita."}
			</Text>

			<Box marginTop={1} flexDirection="column">
				<Text color={field === "uri" ? theme.accent : theme.label}>
					{field === "uri" ? "❯ " : "  "}connection string
				</Text>
				<Box marginLeft={2}>
					{state.status === "connected" && field !== "uri" ? (
						// Depois de conectar, a URI vira exibição mascarada: a senha do
						// Atlas não precisa ficar na tela (nem em print, nem em gravação).
						// Basta voltar o foco para o campo (tab) para editá-la de novo.
						<Text color={theme.muted}>{maskUri(uri)}</Text>
					) : (
						<TextInput
							value={uri}
							onChange={(value) => onChange({ uri: value, db })}
							onSubmit={handleUriSubmit}
							focus={field === "uri" && !connecting && focused}
							placeholder="mongodb+srv://user:senha@cluster.mongodb.net"
						/>
					)}
				</Box>
			</Box>

			{connecting ? (
				<Box marginTop={1}>
					<Spinner frame={frame} label="conectando…" />
				</Box>
			) : null}

			{state.status === "error" ? (
				<Box marginTop={1}>
					<Text color={theme.error}>✖ {state.error}</Text>
				</Box>
			) : null}

			{state.status === "connected" ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.ok}>
						✔ conectado
						{state.databases.length > 0
							? ` · ${state.databases.length} bancos visíveis`
							: " · sem permissão para listar bancos (digite o nome)"}
					</Text>

					<Box marginTop={1} flexDirection="column">
						<Text color={field === "db" ? theme.accent : theme.label}>
							{field === "db" ? "❯ " : "  "}banco
						</Text>

						{/* `typing` troca a lista pelo campo livre — é o "criar banco novo" */}
						{canListDbs && !typing ? (
							<Box marginLeft={2}>
								<Select
									items={[
										...state.databases.map((info) => ({
											value: info.name,
											label: info.name,
											// O tamanho vem de graça no listDatabases e é o que
											// distingue produção de teste quando os nomes são parecidos.
											hint: `${formatBytes(info.sizeOnDisk)}${info.name === db ? " · atual" : ""}`,
										})),
										{
											value: TYPE_NEW,
											label:
												kind === "destination"
													? "＋ criar banco novo"
													: "＋ digitar outro nome",
											hint:
												kind === "destination"
													? "o Mongo cria na primeira escrita"
													: "quando o banco não aparece na lista",
										},
									]}
									onSelect={(value) => {
										if (value === TYPE_NEW) {
											setTyping(true);
											onChange({ uri, db: "" });
											return;
										}
										void handleDbConfirm(value);
									}}
									onHighlight={
										kind === "source"
											? (value) => {
													if (value !== TYPE_NEW) handleDbHighlight(value);
												}
											: undefined
									}
									focus={field === "db" && focused}
									visible={8}
									initialIndex={Math.max(
										0,
										state.databases.findIndex((info) => info.name === db),
									)}
								/>
							</Box>
						) : (
							<Box marginLeft={2} flexDirection="column">
								<TextInput
									value={db}
									onChange={(value) => onChange({ uri, db: value })}
									onSubmit={handleDbConfirm}
									focus={field === "db" && focused}
									placeholder="nome-do-banco"
								/>
								{db.trim() &&
								!state.databases.some((info) => info.name === db.trim()) ? (
									<Text color={theme.warn}>
										{kind === "destination"
											? `"${db.trim()}" ainda não existe — será criado na primeira escrita`
											: `"${db.trim()}" não está entre os bancos visíveis`}
									</Text>
								) : null}
								{typing ? (
									<Text color={theme.muted}>
										enter confirma · esc volta para a lista
									</Text>
								) : null}
							</Box>
						)}
					</Box>
				</Box>
			) : null}
		</Box>
	);
}
