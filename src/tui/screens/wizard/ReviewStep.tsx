import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { buildConfig } from "../../../core/config/buildConfig";
import { type FormState, validateForm } from "../../../core/config/formState";
import type { CollectionEntryRaw } from "../../../core/config/loadConfig";
import {
	suggestFileName,
	toYaml,
	validateConfig,
	writeConfigFile,
} from "../../../core/config/writeConfig";
import { maskUri } from "../../../core/inspect/maskUri";
import { TextInput } from "../../components/TextInput";
import { theme } from "../../theme";

/**
 * Última tela do wizard: mostra o yml exato que será gravado, valida e salva.
 *
 * O preview usa a URI MASCARADA (a senha não aparece), mas o arquivo gravado
 * leva a URI real — são coisas diferentes de propósito.
 */

type Props = {
	form: FormState;
	preserved?: Map<string, CollectionEntryRaw>;
	/** caminho do yml aberto para edição; salvar por cima é o default */
	existingPath?: string;
	/** quantas linhas do preview cabem no painel (vem do layout) */
	previewRows: number;
	onSaved: (path: string, action: "run" | "stay") => void;
	onBack: () => void;
};

export function ReviewStep({
	form,
	preserved,
	existingPath,
	previewRows,
	onSaved,
	onBack,
}: Props) {
	const [fileName, setFileName] = useState(
		existingPath ??
			suggestFileName(form.mode, form.destination.db || form.source.db),
	);
	const [editingName, setEditingName] = useState(false);
	const [confirmOverwrite, setConfirmOverwrite] = useState(false);
	const [result, setResult] = useState<
		{ ok: true; path: string } | { ok: false; errors: string[] } | null
	>(null);

	const config = useMemo(() => buildConfig(form, preserved), [form, preserved]);
	const formErrors = useMemo(() => validateForm(form), [form]);
	const schemaErrors = useMemo(
		() => validateConfig(form.mode, config),
		[form.mode, config],
	);
	const blocked = formErrors.length > 0 || schemaErrors.length > 0;

	const preview = useMemo(() => {
		const masked = maskConfig(config, form);
		return toYaml(masked);
	}, [config, form]);

	function save(action: "run" | "stay") {
		if (blocked) return;

		const target = resolve(fileName);
		// Sobrescrever a config de outra sincronização em produção por engano é
		// caro demais para acontecer com um enter distraído. A comparação é entre
		// caminhos ABSOLUTOS: `existingPath` chega relativo à pasta aberta.
		const editingSameFile = existingPath
			? resolve(existingPath) === target
			: false;
		if (existsSync(target) && !editingSameFile && !confirmOverwrite) {
			setConfirmOverwrite(true);
			return;
		}

		const written = writeConfigFile(target, form.mode, config);
		setResult(written);
		if (written.ok) onSaved(written.path, action);
	}

	useInput(
		(input, key) => {
			if (editingName) return;

			if (key.escape) {
				if (confirmOverwrite) {
					setConfirmOverwrite(false);
					return;
				}
				onBack();
				return;
			}
			if (confirmOverwrite) {
				if (input === "s" || input === "y") save("stay");
				return;
			}
			if (input === "e") {
				setEditingName(true);
				return;
			}
			if (input === "r") {
				save("run");
				return;
			}
			if (key.return) save("stay");
		},
		{ isActive: true },
	);

	return (
		<Box flexDirection="column">
			<Box>
				<Text color={theme.label}>arquivo: </Text>
				<TextInput
					value={fileName}
					onChange={setFileName}
					onSubmit={() => setEditingName(false)}
					focus={editingName}
					placeholder="config.yml"
				/>
				{!editingName ? (
					<Text color={theme.muted}> (e edita o nome)</Text>
				) : null}
			</Box>

			<Box flexDirection="column" marginTop={1}>
				{preview
					.split("\n")
					.slice(0, Math.max(4, previewRows))
					.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: linha de preview não reordena
						<Text key={i} color={theme.muted}>
							{line}
						</Text>
					))}
			</Box>

			{formErrors.length > 0 || schemaErrors.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{formErrors.map((e) => (
						<Text key={e.field} color={theme.error}>
							✖ {e.field}: {e.message}
						</Text>
					))}
					{schemaErrors.map((e) => (
						<Text key={e} color={theme.error}>
							✖ schema: {e}
						</Text>
					))}
				</Box>
			) : null}

			{confirmOverwrite ? (
				<Box marginTop={1}>
					<Text color={theme.warn}>
						⚠ {fileName} já existe. Sobrescrever? (s = sim, esc = cancela)
					</Text>
				</Box>
			) : null}

			{result && !result.ok ? (
				<Box flexDirection="column" marginTop={1}>
					{result.errors.map((e) => (
						<Text key={e} color={theme.error}>
							✖ {e}
						</Text>
					))}
				</Box>
			) : null}

			{result?.ok ? (
				<Box marginTop={1}>
					<Text color={theme.ok}>✔ gravado em {result.path}</Text>
				</Box>
			) : null}
		</Box>
	);
}

/**
 * Copia o config trocando as URIs pela versão mascarada — só para o preview.
 */
function maskConfig(
	config: ReturnType<typeof buildConfig>,
	form: FormState,
): ReturnType<typeof buildConfig> {
	const clone = structuredClone(config) as {
		command: Record<string, Record<string, { uri?: string }>>;
	};
	const body = clone.command[form.mode];
	if (body?.source?.uri) body.source.uri = maskUri(body.source.uri);
	if (body?.destination?.uri)
		body.destination.uri = maskUri(body.destination.uri);
	return clone as ReturnType<typeof buildConfig>;
}
