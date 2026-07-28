import type { CollEstimate } from "./collStats";
import type { CollIndexes } from "./indexSummary";
import type { DbEntry } from "./inspectDb";

/**
 * "Total de coisas que serão enviadas" — e isso depende do MODO, não só da
 * seleção:
 *
 * - `sync`  copia documentos; índices só com `copyIndexes: true`; views só
 *           com `copyViews` (true ou lista de nomes).
 * - `migrate` usa mongodump/mongorestore, que JÁ leva os índices junto — não
 *           existe opção de copiar ou não. Views não passam.
 * - `ttl`   não envia nada: cria um índice TTL por collection selecionada.
 *
 * Função pura: recebe o que o `core/inspect` já coletou e devolve os totais.
 * Fica fora do React para ser testável e para a UI não recalcular regra de
 * negócio dentro de um componente.
 */

export type TuiMode = "sync" | "migrate" | "ttl";

export type TransferPlan = {
	mode: TuiMode;
	collections: number;
	/** soma de documentos das collections selecionadas */
	docs: number;
	/** true quando algum número da soma veio de estimativa (metadata) */
	approximate: boolean;
	/** bytes de dados (sem índices) */
	dataSize: number;
	/** índices secundários que serão criados no destino */
	indexes: number;
	/** views que serão recriadas no destino */
	views: number;
	/** avisos que a TUI mostra antes de deixar salvar/disparar */
	warnings: string[];
};

export type PlanInput = {
	mode: TuiMode;
	selected: string[];
	estimates: CollEstimate[];
	indexes?: CollIndexes[];
	sourceViews?: DbEntry[];
	copyIndexes?: boolean;
	copyViews?: boolean | string[];
};

export function buildTransferPlan(input: PlanInput): TransferPlan {
	const {
		mode,
		selected,
		estimates,
		indexes = [],
		sourceViews = [],
		copyIndexes = false,
		copyViews = false,
	} = input;

	const chosen = new Set(selected);
	const picked = estimates.filter((e) => chosen.has(e.name));

	const docs = picked.reduce((acc, e) => acc + e.docs, 0);
	const dataSize = picked.reduce((acc, e) => acc + e.storageSize, 0);
	// Sem nenhuma estimativa carregada o número é 0 — e 0 exato mentiria.
	const approximate = picked.length === 0 ? true : picked.some((e) => !e.exact);

	const indexCount = countIndexes(mode, chosen, indexes, copyIndexes);
	const viewCount = countViews(mode, sourceViews, copyViews);

	return {
		mode,
		collections: mode === "ttl" ? chosen.size : picked.length || chosen.size,
		docs: mode === "ttl" ? 0 : docs,
		approximate,
		dataSize: mode === "ttl" ? 0 : dataSize,
		indexes: indexCount,
		views: viewCount,
		warnings: buildWarnings(mode, chosen, sourceViews, copyViews),
	};
}

function countIndexes(
	mode: TuiMode,
	chosen: Set<string>,
	indexes: CollIndexes[],
	copyIndexes: boolean,
): number {
	// migrate leva índices sempre (mongorestore); ttl cria 1 índice por coll.
	if (mode === "ttl") return chosen.size;
	if (mode === "sync" && !copyIndexes) return 0;
	return indexes
		.filter((i) => chosen.has(i.collection))
		.reduce((acc, i) => acc + i.secondaryCount, 0);
}

function countViews(
	mode: TuiMode,
	sourceViews: DbEntry[],
	copyViews: boolean | string[],
): number {
	if (mode !== "sync") return 0;
	if (copyViews === true) return sourceViews.length;
	if (Array.isArray(copyViews)) {
		const wanted = new Set(copyViews);
		return sourceViews.filter((v) => wanted.has(v.name)).length;
	}
	return 0;
}

/**
 * Avisos que valem interromper o usuário. O caso da view órfã é real e silencioso:
 * uma view cujo `viewOn` não está sendo sincronizado é criada no destino e
 * responde VAZIO — parece que funcionou.
 */
function buildWarnings(
	mode: TuiMode,
	chosen: Set<string>,
	sourceViews: DbEntry[],
	copyViews: boolean | string[],
): string[] {
	const warnings: string[] = [];

	if (chosen.size === 0) {
		warnings.push("Nenhuma collection selecionada.");
	}

	if (mode === "sync" && copyViews !== false) {
		const wanted =
			copyViews === true
				? sourceViews
				: sourceViews.filter((v) => (copyViews as string[]).includes(v.name));

		const orphans = wanted.filter((v) => v.viewOn && !chosen.has(v.viewOn));
		for (const v of orphans) {
			warnings.push(
				`A view "${v.name}" depende de "${v.viewOn}", que não está na seleção — ela existirá no destino, mas retornará vazio.`,
			);
		}
	}

	return warnings;
}
