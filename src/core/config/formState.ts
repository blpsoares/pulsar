import type { CopyIndexesOption } from "../../types/parseYml";
import type { TuiMode } from "../inspect/summary";

/**
 * Estado do formulário da TUI — a fonte única de verdade do wizard.
 *
 * É um tipo puro, sem React e sem Mongo: `buildConfig` transforma isso em yml
 * e `loadConfig` faz o caminho de volta. Manter os dois lados olhando para o
 * MESMO tipo é o que garante que abrir um yml existente, não mexer em nada e
 * salvar produza um arquivo equivalente.
 */

export type FormState = {
	mode: TuiMode;
	source: { uri: string; db: string };
	/** ignorado no modo ttl, que opera num banco só */
	destination: { uri: string; db: string };
	/** nomes escolhidos; sempre explícito no yml (o `--all` é decisão de runtime) */
	collections: string[];
	// --- avançado (sync) ---
	/** `true` = todos os índices; lista = só os escolhidos, por collection. */
	copyIndexes: CopyIndexesOption;
	copyViews: boolean | string[];
	logging: { verbose: boolean; progress: boolean; lang?: "en" | "pt" };
	performance: {
		parallel?: number;
		batchSize?: number;
		flushIntervalMs?: number;
	};
	// --- migrate ---
	queryString?: string;
	// --- ttl ---
	ttlDefaults: {
		field?: string;
		deriveFromId?: boolean;
		expire?: string;
	};
};

/**
 * Defaults iguais aos do CLI, para o yml gerado não mudar comportamento
 * silenciosamente em relação a rodar o comando na mão.
 */
export function emptyForm(mode: TuiMode = "sync"): FormState {
	return {
		mode,
		source: { uri: "", db: "" },
		destination: { uri: "", db: "" },
		collections: [],
		copyIndexes: false,
		copyViews: false,
		logging: { verbose: false, progress: true },
		performance: {},
		ttlDefaults: {},
	};
}

export type FieldError = { field: string; message: string };

/**
 * Validação de PREENCHIMENTO (o que o usuário ainda não digitou), separada da
 * validação de ESQUEMA (Zod, em `writeConfig`). São coisas diferentes: aqui o
 * objetivo é acender o campo em vermelho na tela, não rejeitar um arquivo.
 */
export function validateForm(form: FormState): FieldError[] {
	const errors: FieldError[] = [];

	if (!form.source.uri.trim())
		errors.push({
			field: "source.uri",
			message: "URI da origem é obrigatória",
		});
	if (!form.source.db.trim())
		errors.push({
			field: "source.db",
			message: "Banco de origem é obrigatório",
		});

	if (form.mode !== "ttl") {
		if (!form.destination.uri.trim())
			errors.push({
				field: "destination.uri",
				message: "URI do destino é obrigatória",
			});
		if (!form.destination.db.trim())
			errors.push({
				field: "destination.db",
				message: "Banco de destino é obrigatório",
			});
		if (
			form.source.uri.trim() === form.destination.uri.trim() &&
			form.source.db.trim() === form.destination.db.trim()
		)
			errors.push({
				field: "destination.db",
				message:
					"Origem e destino são o mesmo banco — isso sobrescreveria a origem",
			});
	}

	if (form.collections.length === 0)
		errors.push({
			field: "collections",
			message: "Selecione ao menos uma collection",
		});

	if (form.mode === "ttl") {
		const { field, deriveFromId, expire } = form.ttlDefaults;
		if (!field && !deriveFromId)
			errors.push({
				field: "ttl.field",
				message:
					"Defina um campo Date ou marque 'derivar do _id' — TTL não funciona sem âncora de data",
			});
		if (field && deriveFromId)
			errors.push({
				field: "ttl.field",
				message: "'campo' e 'derivar do _id' são mutuamente exclusivos",
			});
		if (!expire)
			errors.push({
				field: "ttl.expire",
				message: "Defina a duração (ex.: 30d, 6mo, 1h)",
			});
	}

	return errors;
}
