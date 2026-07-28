import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Spinner } from "../../components/Frame";
import { Select } from "../../components/Select";
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
};

type Field = "uri" | "db";

export function ConnectionStep({
	kind,
	uri,
	db,
	onChange,
	inspector,
	onDone,
	onBack,
}: Props) {
	const [field, setField] = useState<Field>("uri");
	const { state, connect, loadDb } = inspector;
	const connecting = state.status === "connecting";
	const frame = useSpinner(connecting);

	const canListDbs = state.status === "connected" && state.databases.length > 0;

	useInput(
		(_input, key) => {
			if (key.escape) onBack();
			// Tab volta para a URI para corrigir sem refazer o passo.
			if (key.tab && state.status === "connected") {
				setField((f) => (f === "uri" ? "db" : "uri"));
			}
		},
		{ isActive: !connecting },
	);

	async function handleUriSubmit(value: string) {
		const ok = await connect(value);
		if (ok) setField("db");
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

			<Box marginTop={1}>
				<Text color={field === "uri" ? theme.accent : theme.label}>
					{field === "uri" ? "❯ " : "  "}connection string{" "}
				</Text>
				<TextInput
					value={uri}
					onChange={(value) => onChange({ uri: value, db })}
					onSubmit={handleUriSubmit}
					focus={field === "uri" && !connecting}
					placeholder="mongodb+srv://user:senha@cluster.mongodb.net"
				/>
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

						{canListDbs ? (
							<Box marginLeft={2}>
								<Select
									items={state.databases.map((name) => ({
										value: name,
										label: name,
										hint: name === db ? "atual" : undefined,
									}))}
									onSelect={(value) => handleDbConfirm(value)}
									focus={field === "db"}
									visible={8}
									initialIndex={Math.max(0, state.databases.indexOf(db))}
								/>
							</Box>
						) : (
							<Box marginLeft={2}>
								<TextInput
									value={db}
									onChange={(value) => onChange({ uri, db: value })}
									onSubmit={handleDbConfirm}
									focus={field === "db"}
									placeholder="nome-do-banco"
								/>
							</Box>
						)}
					</Box>
				</Box>
			) : null}
		</Box>
	);
}
