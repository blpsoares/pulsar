import Bottleneck from "bottleneck";
import {
	type VerifyResult,
	verifyCollection,
} from "../core/verify/verifyCollection";
import { conn } from "../db/conn";
import { getCollections } from "../functions/getCollections";
import { type SyncYmlOptions, syncYmlSchema } from "../types/parseYml";
import { customLog } from "../utils/customLog";
import { setLang, t } from "../utils/i18n";
import { setLogConfig } from "../utils/logConfig";
import parseYml from "../utils/parseYml";

export type VerifyOptionsCli = {
	all?: boolean;
	deep?: boolean;
	reconcile?: boolean;
	parallel?: string;
	batch?: string;
	json?: boolean;
	collections?: string;
};

const short = (id: unknown): string => {
	const s =
		typeof id === "object" && id !== null ? JSON.stringify(id) : String(id);
	return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * `pulsar verify <config.yml>` — confere, collection a collection, se o destino
 * realmente tem o que a origem tem.
 *
 * Existe porque o `sync` decide "está em dia" pelo carimbo `dumpCompletedAt` no
 * `__sync`, que é bookkeeping e não medição: um dump carimbado por engano nunca
 * mais é revisto, e o change stream não reconcilia (só entrega mudança nova).
 * Este comando é a única coisa que responde "os dados chegaram?" olhando dado.
 *
 * Sai com código 1 quando há divergência — dá pra pendurar num cron/CI.
 */
export async function verifyCommand(
	ymlPath: string,
	cliParams: VerifyOptionsCli,
) {
	const options = parseYml<SyncYmlOptions>(ymlPath, syncYmlSchema);
	setLang(
		process.env.PULSAR_LANG || options.command.sync.logging?.lang || "en",
	);
	setLogConfig({ verbose: false, progress: false });

	const toNum = (v: unknown, dflt: number): number => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : dflt;
	};
	const parallel = toNum(cliParams.parallel, 4);
	const batchSize = toNum(cliParams.batch, 2000);
	const mode = cliParams.deep ? "deep" : "count";
	// Reconciliar sem varrer _id a _id é impossível: o modo count não sabe QUAIS
	// docs faltam. Então --reconcile implica --deep, em vez de falhar em silêncio.
	const reconcile = Boolean(cliParams.reconcile);
	const effectiveMode = reconcile ? "deep" : mode;

	const client = await conn(options.command.sync.source.uri, "source");
	const srcDb = client.db(options.command.sync.source.db);
	const destClient = await conn(
		options.command.sync.destination.uri,
		"destination",
	);
	const destDb = destClient.db(options.command.sync.destination.db);

	let collections = await getCollections(
		srcDb,
		cliParams,
		ymlPath,
		options.command.sync.collections,
	);
	if (cliParams.collections) {
		const only = new Set(
			cliParams.collections
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		);
		collections = collections.filter((c) => only.has(c.name));
	}

	if (!cliParams.json) {
		customLog(
			"info",
			t("verify.start", {
				count: collections.length,
				mode: t(
					effectiveMode === "deep" ? "verify.mode_deep" : "verify.mode_count",
				),
				reconcile: reconcile ? t("verify.reconcile_on") : "",
				parallel,
			}),
		);
	}

	const limiter = new Bottleneck({ maxConcurrent: parallel });
	const results = await Promise.all(
		collections.map((c) =>
			limiter.schedule(() =>
				verifyCollection(srcDb.collection(c.name), destDb.collection(c.name), {
					filter: c.filter,
					mode: effectiveMode,
					batchSize,
					reconcile,
				}),
			),
		),
	);

	await client.close().catch(() => {});
	await destClient.close().catch(() => {});

	if (cliParams.json) {
		console.log(JSON.stringify(results, null, 2));
		process.exit(diverged(results).length > 0 ? 1 : 0);
	}

	let anyApprox = false;
	for (const r of results) {
		if (r.error) {
			customLog(
				"error",
				t("verify.row_error", { coll: r.coll, reason: r.error }),
			);
			continue;
		}
		anyApprox ||= r.approximate;
		if (r.missing > 0) {
			const sample =
				r.missingSample.length > 0
					? t("verify.sample", {
							ids: r.missingSample.slice(0, 5).map(short).join(", "),
						})
					: "";
			customLog(
				"warn",
				t("verify.row_missing", {
					coll: r.coll,
					source: r.sourceCount,
					dest: r.destCount,
					missing: r.missing,
					sample,
				}),
			);
			if (r.reconciled > 0) {
				customLog(
					"success",
					t("verify.reconciled", { coll: r.coll, n: r.reconciled }),
				);
			}
		} else if (r.missing === 0 && effectiveMode === "deep") {
			customLog(
				"success",
				t("verify.row_ok", { coll: r.coll, source: r.sourceCount }),
			);
		} else if (r.sourceCount > r.destCount) {
			customLog(
				"warn",
				t("verify.row_deficit", {
					coll: r.coll,
					source: r.sourceCount,
					dest: r.destCount,
					diff: r.sourceCount - r.destCount,
				}),
			);
		} else if (r.destCount > r.sourceCount) {
			customLog(
				"info",
				t("verify.row_extra", {
					coll: r.coll,
					source: r.sourceCount,
					dest: r.destCount,
				}),
			);
		} else {
			customLog(
				"success",
				t("verify.row_ok", { coll: r.coll, source: r.sourceCount }),
			);
		}
	}

	const bad = diverged(results);
	const errors = results.filter((r) => r.error);
	if (anyApprox && effectiveMode === "count") {
		customLog("info", t("verify.approximate"));
	}
	if (bad.length === 0) {
		customLog(
			"success",
			t("verify.summary_ok", { total: results.length }),
			true,
		);
	} else {
		const missingTotal = bad.reduce((a, r) => a + residual(r), 0);
		customLog(
			"error",
			t("verify.summary_bad", {
				bad: bad.length,
				total: results.length,
				missing: missingTotal,
			}),
			true,
		);
		if (effectiveMode === "count") customLog("info", t("verify.summary_hint"));
	}
	if (errors.length > 0) {
		customLog("error", t("verify.errors", { n: errors.length }));
	}

	process.exit(bad.length > 0 || errors.length > 0 ? 1 : 0);
}

/**
 * Collections que ficaram DEVENDO dado ao destino (sobra não é divergência).
 * O que conta é o RESÍDUO: com `--reconcile`, o que foi recopiado já não falta
 * mais — sair com erro depois de consertar tudo faria o comando mentir.
 */
function diverged(results: VerifyResult[]): VerifyResult[] {
	return results.filter((r) => !r.error && residual(r) > 0);
}

/** Docs ainda faltando após a reconciliação (ou o déficit bruto, no modo count). */
export function residual(r: VerifyResult): number {
	if (r.missing === -1) return Math.max(0, r.sourceCount - r.destCount);
	return Math.max(0, r.missing - r.reconciled);
}
