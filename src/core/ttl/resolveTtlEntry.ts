import type { TtlCollectionEntry, TtlDefaults } from "../../types/parseYml";
import { parseDuration } from "./parseDuration";

export type ResolvedTtl = {
	name: string;
	field: string;
	deriveFromId: boolean;
	expireAfterSeconds: number;
};

/** Nome do campo materializado a partir do _id quando deriveFromId está ligado. */
export const DERIVED_FIELD = "_created";

/**
 * Resolve uma entrada de collection contra os defaults, aplicando precedência:
 * o que a collection define ganha; senão herda do default. Lança erro quando
 * não dá pra resolver um campo de TTL (nada implícito).
 */
export function resolveTtlEntry(
	entry: TtlCollectionEntry,
	defaults?: TtlDefaults,
): ResolvedTtl {
	const obj = typeof entry === "string" ? { name: entry } : entry;
	const d = defaults ?? {};

	// Colisão no mesmo nível: a collection definiu os dois de uma vez.
	if (obj.field && obj.deriveFromId) {
		throw new Error(
			`Collection "${obj.name}": "field" e "deriveFromId" são mutuamente exclusivos`,
		);
	}

	// Resolve a fonte do campo respeitando precedência: se a collection define
	// explicitamente field OU deriveFromId, esse nível ganha por inteiro e
	// SUPRIME o que viesse do default (field explícito vence deriveFromId default
	// e vice-versa). Só herda do default quando a collection não disse nada.
	let field: string | undefined;
	let deriveFromId: boolean;
	if (obj.field) {
		field = obj.field;
		deriveFromId = false;
	} else if (obj.deriveFromId) {
		field = undefined;
		deriveFromId = true;
	} else {
		field = d.field;
		deriveFromId = d.deriveFromId ?? false;
	}

	if (field && deriveFromId) {
		throw new Error(
			`Collection "${obj.name}": "field" e "deriveFromId" são mutuamente exclusivos`,
		);
	}
	if (!field && !deriveFromId) {
		throw new Error(
			`Collection "${obj.name}" sem campo de TTL definido: informe "field" (campo Date existente) ou "deriveFromId: true"`,
		);
	}

	const rawExpire =
		obj.expire ?? obj.expireAfterSeconds ?? d.expire ?? d.expireAfterSeconds;
	if (rawExpire === undefined) {
		throw new Error(
			`Collection "${obj.name}" sem "expire"/"expireAfterSeconds" definido`,
		);
	}

	return {
		name: obj.name,
		field: deriveFromId ? DERIVED_FIELD : (field as string),
		deriveFromId,
		expireAfterSeconds: parseDuration(rawExpire),
	};
}
