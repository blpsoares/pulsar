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
import parseYml from "../utils/parseYml";

type Plan = {
	uri: string;
	db: string;
	entries: TtlCollectionEntry[];
	defaults?: TtlDefaults;
	all: boolean;
};

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
		};
	}

	// modo CLI: validações de presença/exclusividade
	if (!cli.uri || !cli.db) throw new Error("Modo CLI exige --uri e --db");
	if (!cli.expire) throw new Error("Modo CLI exige --expire");
	if (cli.field && cli.deriveFromId)
		throw new Error("--field e --derive-from-id são mutuamente exclusivos");
	if (!cli.field && !cli.deriveFromId)
		throw new Error("Modo CLI exige --field ou --derive-from-id");
	if (cli.collections && cli.all)
		throw new Error("--collections e --all são mutuamente exclusivos");
	if (!cli.collections && !cli.all)
		throw new Error("Modo CLI exige --collections ou --all");

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

	return { uri: cli.uri, db: cli.db, entries, defaults, all: Boolean(cli.all) };
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

		const results: TtlResult[] = [];
		for (const r of resolved) {
			const out = await applyTtl(db, r);
			results.push(out);
			const derived =
				out.derivedCount !== undefined
					? ` (_created em ${out.derivedCount} docs)`
					: "";
			customLog(
				"success",
				`TTL em ${out.name}: ${out.field} expira em ${out.expireAfterSeconds}s${derived}`,
			);
		}

		customLog("info", `TTL aplicado em ${results.length} collection(s).`);
		return results;
	} catch (error) {
		throw errorHandler(error, "TTL:COMMAND");
	} finally {
		await client.close();
	}
}

export default ttlCommand;
