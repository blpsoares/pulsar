import Bottleneck from "bottleneck";
import { applyTtl, type TtlResult } from "../core/ttl/applyTtl";
import { type ResolvedTtl, resolveTtlEntry } from "../core/ttl/resolveTtlEntry";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import type { TtlOptionsCli } from "../types/cliOptions";
import {
	type TtlCollectionEntry,
	type TtlDefaults,
	type TtlYmlOptions,
	ttlYmlSchema,
} from "../types/parseYml";
import { customLog } from "../utils/customLog";
import { t } from "../utils/i18n";
import parseYml from "../utils/parseYml";

/** Concorrência padrão: modesto por ser cluster (possivelmente compartilhado). */
const DEFAULT_PARALLEL = 4;

type Plan = {
	uri: string;
	db: string;
	entries: TtlCollectionEntry[];
	defaults?: TtlDefaults;
	all: boolean;
	parallel: number;
};

/** Resolve a concorrência: CLI (-p) vence yml (performance.parallel), senão default. */
function resolveParallel(cli: TtlOptionsCli, ymlParallel?: number): number {
	const fromCli = cli.parallel !== undefined ? Number(cli.parallel) : undefined;
	const chosen = fromCli ?? ymlParallel ?? DEFAULT_PARALLEL;
	return Number.isFinite(chosen) && chosen > 0
		? Math.floor(chosen)
		: DEFAULT_PARALLEL;
}

/** Monta o plano a partir do yml (se houver arquivo) ou das flags CLI. */
function buildPlan(file: string | undefined, cli: TtlOptionsCli): Plan {
	if (file) {
		const opts = parseYml<TtlYmlOptions>(file, ttlYmlSchema);
		const { ttl } = opts.command;
		return {
			uri: ttl.source.uri,
			db: ttl.source.db,
			entries: ttl.collections ?? [],
			defaults: ttl.defaults,
			all: false,
			parallel: resolveParallel(cli, ttl.performance?.parallel),
		};
	}

	// modo CLI: validações de presença/exclusividade
	if (!cli.uri || !cli.db) throw new Error(t("ttl.err_uri_db"));
	if (!cli.expire) throw new Error(t("ttl.err_expire"));
	if (cli.field && cli.deriveFromId)
		throw new Error(t("ttl.err_field_derive_exclusive"));
	if (!cli.field && !cli.deriveFromId)
		throw new Error(t("ttl.err_field_or_derive"));
	if (cli.collections && cli.all)
		throw new Error(t("ttl.err_collections_all_exclusive"));
	if (!cli.collections && !cli.all)
		throw new Error(t("ttl.err_collections_or_all"));

	const defaults: TtlDefaults = {
		field: cli.field,
		deriveFromId: cli.deriveFromId,
		expire: cli.expire,
	};
	const entries: TtlCollectionEntry[] = cli.collections
		? cli.collections
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

	return {
		uri: cli.uri,
		db: cli.db,
		entries,
		defaults,
		all: Boolean(cli.all),
		parallel: resolveParallel(cli),
	};
}

export async function ttlCommand(
	file: string | undefined,
	cli: TtlOptionsCli,
): Promise<TtlResult[]> {
	const plan = buildPlan(file, cli);
	const client = await conn(plan.uri, "ttl");
	const db = client.db(plan.db);

	try {
		// resolve a lista de nomes (suporta --all reusando getCollections)
		const collectionEntries = await getCollections(
			db,
			{ all: plan.all },
			file ?? "(cli)",
			plan.entries as never,
		);

		// pra cada nome, casa com a entry original (pra herdar field/expire) e resolve
		const resolved: ResolvedTtl[] = collectionEntries.map(({ name }) => {
			const original = plan.entries.find(
				(e) => (typeof e === "string" ? e : e.name) === name,
			);
			return resolveTtlEntry(original ?? name, plan.defaults);
		});

		// Paralelismo no nível de collection (Bottleneck), com teto configurável.
		// allSettled: uma collection que falha NÃO derruba as outras (relatório honesto).
		const limiter = new Bottleneck({ maxConcurrent: plan.parallel });
		customLog(
			"info",
			t("ttl.applying", { count: resolved.length, parallel: plan.parallel }),
		);

		const settled = await Promise.allSettled(
			resolved.map((r) =>
				limiter.schedule(async () => {
					const out = await applyTtl(db, r);
					const derived =
						out.derivedCount !== undefined
							? t("ttl.derived_frag", { count: out.derivedCount })
							: "";
					customLog(
						"success",
						t("ttl.applied_coll", {
							name: out.name,
							field: out.field,
							seconds: out.expireAfterSeconds,
							derived,
						}),
					);
					return out;
				}),
			),
		);

		const results: TtlResult[] = [];
		const failures: { name: string; error: string }[] = [];
		settled.forEach((s, i) => {
			if (s.status === "fulfilled") results.push(s.value);
			else
				failures.push({
					name: resolved[i].name,
					error:
						s.reason instanceof Error ? s.reason.message : String(s.reason),
				});
		});

		for (const f of failures)
			customLog(
				"error",
				t("ttl.failed_coll", { name: f.name, error: f.error }),
			);
		customLog(
			failures.length ? "error" : "info",
			t("ttl.summary", {
				applied: results.length,
				total: resolved.length,
				extra: failures.length
					? t("ttl.summary_failed", { failed: failures.length })
					: ".",
			}),
		);
		return results;
	} catch (error) {
		throw errorHandler(error, "TTL:COMMAND");
	} finally {
		await client.close();
	}
}

export default ttlCommand;
