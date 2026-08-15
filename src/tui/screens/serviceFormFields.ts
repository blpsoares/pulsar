import type { TuiMode } from "../../core/inspect/summary";
import type { StepResult } from "../../core/service/execStep";
import type { Backend, ServiceStep } from "../../core/service/types";
import type { CopyIndexesOption } from "../../types/parseYml";

/**
 * Lógica PURA do formulário único de serviço (Task 13).
 *
 * Separada do componente para poder ser testada sem montar React/ink — o
 * mesmo padrão de `layout.ts`: a geometria/decisão é testável, o desenho não
 * precisa ser.
 */

export type FieldId =
	| "name"
	| "mode"
	| "config"
	| "sourceUri"
	| "sourceDb"
	| "destUri"
	| "destDb"
	| "collections"
	| "views"
	| "indexes"
	| "ttlField"
	| "ttlDeriveFromId"
	| "ttlExpire"
	| "backend"
	| "boot";

export const FIELD_LABEL: Record<FieldId, string> = {
	name: "nome",
	mode: "modo",
	config: "config",
	sourceUri: "origem.uri",
	sourceDb: "origem.db",
	destUri: "destino.uri",
	destDb: "destino.db",
	collections: "collections",
	views: "views",
	indexes: "índices",
	ttlField: "ttl.campo",
	ttlDeriveFromId: "ttl.derivar do _id",
	ttlExpire: "ttl.duração",
	backend: "backend",
	boot: "boot",
};

/**
 * Campos visíveis pro modo atual — os mesmos 12 da task original, mais os 3
 * de TTL (Fix 1 da Rodada 1: o modo `ttl` estava na tela sem como resolver
 * `defaults.field`/`deriveFromId`/`expire`, e `validateConfig` sempre recusa
 * um `ttl` sem âncora de data — modo oferecido e inalcançável é pior que
 * ausente). Cada bloco é excluído ESTRUTURALMENTE por modo (ttl não tem
 * destino nem view/índice; sync/migrate não têm `defaults` de ttl).
 *
 * Isto é diferente de "campo que depende de algo ainda não preenchido" (ex.:
 * `collections` sem conexão): esse caso o componente trata como campo
 * DESABILITADO com o motivo ao lado, nunca ausente — ver `fieldNeedsSource` /
 * `fieldNeedsDestination` abaixo. Aqui a exclusão é por MODO, não por estado.
 */
export function visibleFields(mode: TuiMode): FieldId[] {
	const fields: FieldId[] = ["name", "mode", "config", "sourceUri", "sourceDb"];
	if (mode !== "ttl") fields.push("destUri", "destDb");
	fields.push("collections");
	if (mode === "sync") fields.push("views", "indexes");
	if (mode === "ttl") fields.push("ttlField", "ttlDeriveFromId", "ttlExpire");
	fields.push("backend", "boot");
	return fields;
}

/** Campo cujo editor de verdade (Select de bancos / picker) depende da ORIGEM estar conectada. */
export function fieldNeedsSource(id: FieldId): boolean {
	return (
		id === "sourceDb" ||
		id === "collections" ||
		id === "views" ||
		id === "indexes"
	);
}

/** Campo cujo editor de verdade depende do DESTINO estar conectado. */
export function fieldNeedsDestination(id: FieldId): boolean {
	return id === "destDb";
}

/**
 * Os três únicos passos privilegiados do projeto, todos sobre boot.
 *
 * Aviso conservador de propósito: o systemd normalmente resolve o linger sem
 * sudo, mas prometer "não vai precisar" e depois precisar é pior do que
 * avisar à toa.
 */
export function needsSudo(backend: Backend): boolean {
	return backend === "docker" || backend === "pm2" || backend === "systemd";
}

/** "a, b ,  c" -> ["a","b","c"], sem vazios — usado nos campos-lista sem conexão. */
export function parseCommaList(input: string): string[] {
	return input
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function formatCommaList(items: string[]): string {
	return items.join(", ");
}

/**
 * Formato de digitação à mão para índices, sem conexão: "collection.índice".
 * Achatado (não aninhado) porque é o que dá pra digitar numa linha só; o
 * agrupamento por collection acontece aqui.
 */
export function parseIndexesList(
	input: string,
): { collection: string; indexes: string[] }[] {
	const groups = new Map<string, string[]>();

	for (const raw of parseCommaList(input)) {
		const dot = raw.indexOf(".");
		if (dot <= 0) continue; // sem "." não dá pra saber a collection — entrada ignorada
		const collection = raw.slice(0, dot).trim();
		const index = raw.slice(dot + 1).trim();
		if (!collection || !index) continue;
		const list = groups.get(collection);
		if (list) list.push(index);
		else groups.set(collection, [index]);
	}

	return [...groups.entries()].map(([collection, indexes]) => ({
		collection,
		indexes,
	}));
}

export function formatIndexesList(value: CopyIndexesOption): string {
	if (value === true || value === false) return "";
	return value
		.flatMap((entry) =>
			entry.indexes.map((idx) => `${entry.collection}.${idx}`),
		)
		.join(", ");
}

export type ManualStepResult = {
	step: ServiceStep;
	ok: boolean;
	output: string;
};

/**
 * Isola os resultados dos passos MANUAIS de um `InstallResult` (Rodada 2).
 *
 * `installService` (`manager.ts`) roda `plan.steps` e depois, só se `ok`,
 * `plan.manualSteps` — os DOIS tipos de passo terminam misturados no mesmo
 * array `results`. O objeto `ServiceStep` que entra em `plan.manualSteps`
 * FLUI por referência através de `execStep`/`runPrivilegedStep` até o
 * `StepResult` (`result.step === step`, nunca clonado) — por isso dá pra
 * identificar "isto era manual" com `includes`, sem precisar de `id`/nome.
 */
export function manualStepResults(
	results: StepResult[],
	manualSteps: ServiceStep[],
): ManualStepResult[] {
	return results
		.filter((r) => manualSteps.includes(r.step))
		.map((r) => ({ step: r.step, ok: r.ok, output: r.output }));
}

/**
 * `boot` final a gravar no registro — a lógica mais arriscada do form (Rodada
 * 2), porque errar aqui é o MESMO pecado que motivou o redesenho: afirmar que
 * algo está configurado quando não está.
 *
 * Nunca `true` quando:
 * - a instalação não terminou `ok` (passo essencial falhou — nada depois dele
 *   rodou, incluindo os passos de boot);
 * - algum passo com sudo foi RECUSADO (`skippedPrivileged` não vazio);
 * - existiu QUALQUER passo manual, mesmo tendo saído com código 0 — um passo
 *   manual pode ter só IMPRESSO uma instrução (`pm2 startup`, que é
 *   `privileged: true` sem pedir sudo de verdade) em vez de efetivamente
 *   configurado o boot, e o registro não tem como distinguir os dois casos.
 *   Ser conservador aqui é a mesma régua do `needsSudo`: prometer errado é
 *   pior que avisar demais.
 */
export function resolveFinalBoot(
	requestedBoot: boolean,
	installOk: boolean,
	skippedPrivileged: unknown[],
	manual: ManualStepResult[],
): boolean {
	return (
		requestedBoot &&
		installOk &&
		skippedPrivileged.length === 0 &&
		manual.length === 0
	);
}
