import type { TuiMode } from "../../core/inspect/summary";
import type { Backend } from "../../core/service/types";
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
	backend: "backend",
	boot: "boot",
};

/**
 * Campos visíveis pro modo atual — SEMPRE os mesmos 12, menos os que não
 * existem ESTRUTURALMENTE naquele modo (ttl não tem destino; migrate não
 * escolhe view/índice, o mongorestore leva o que existe sempre).
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
