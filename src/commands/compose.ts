import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { buildInstanceCompose } from "../core/compose/buildCompose";
import { detectConfigs } from "../core/compose/detectConfigs";
import { recommendResources } from "../core/compose/recommend";
import { t } from "../utils/i18n";

const GiB = 1024 * 1024 * 1024;
const BASE_FILE = "docker-compose-limit.yml";

/** Number() seguro: devolve o fallback se vazio/NaN. */
function numOr(input: string | null, fallback: number): number {
	const n = Number((input ?? "").trim());
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

type Committed = { mem: number; cpus: number; names: string[] };

/** Soma mem_limit e cpus já comprometidos pelos containers pulsar-sync existentes. */
function committedResources(): Committed {
	try {
		const names = execSync(
			'docker ps -a --filter "name=pulsar-sync" --format "{{.Names}}"',
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean);
		let mem = 0;
		let cpus = 0;
		for (const n of names) {
			const raw = execSync(
				`docker inspect --format "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}" ${n}`,
				{ encoding: "utf8" },
			).trim();
			const [m, nano] = raw.split(/\s+/).map(Number);
			if (Number.isFinite(m)) mem += m;
			if (Number.isFinite(nano)) cpus += nano / 1e9;
		}
		return { mem, cpus, names };
	} catch {
		return { mem: 0, cpus: 0, names: [] };
	}
}

/** Próximo sufixo numérico livre (pulsar-sync base = 1). */
function nextSuffix(names: string[]): string {
	let max = 1;
	for (const n of names) {
		const m = n.match(/pulsar-sync-(\d+)$/);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return String(max + 1);
}

export async function composeUp(): Promise<void> {
	if (!existsSync(BASE_FILE)) {
		console.log(
			chalk.red(t("compose.base_not_found", { file: BASE_FILE })) +
				chalk.gray(t("compose.run_at_root")),
		);
		process.exit(1);
	}

	const cores = os.cpus().length || 1;
	const totalRam = os.totalmem();
	const usedRam = totalRam - os.freemem();
	const committed = committedResources();

	console.log(`\n${chalk.bold.cyan(t("compose.title"))}`);
	console.log(chalk.gray("─".repeat(58)));
	console.log(
		`${chalk.gray(t("compose.existing_instances"))} ${
			committed.names.length
				? chalk.yellowBright(committed.names.join(", "))
				: chalk.gray(t("compose.none"))
		}`,
	);
	console.log(
		t("compose.ram_line", {
			total: (totalRam / GiB).toFixed(1),
			used: (usedRam / GiB).toFixed(1),
			committed: (committed.mem / GiB).toFixed(1),
		}),
	);
	console.log(
		`${t("compose.cpu_line", { cores, committed: committed.cpus })}\n`,
	);

	// ── detecta configs do pulsar ───────────────────────────────────────────
	const found = [
		...detectConfigs(process.cwd()),
		...detectConfigs(join(process.cwd(), "configs")).map((c) => ({
			...c,
			file: `configs/${c.file}`,
		})),
	];
	const syncs = found.filter((c) => c.kind === "sync");

	if (syncs.length) {
		console.log(chalk.bold(t("compose.sync_configs_found")));
		syncs.forEach((c, i) => {
			console.log(
				t("compose.config_item", {
					n: i + 1,
					file: c.file,
					dest: c.destDb ?? "?",
				}),
			);
		});
		const others = found.filter(
			(c) => c.kind !== "sync" && c.kind !== "desconhecido",
		);
		if (others.length) {
			console.log(
				chalk.gray(
					t("compose.ignored_for_sync", {
						list: others.map((o) => `${o.file}[${o.kind}]`).join(", "),
					}),
				),
			);
		}
		console.log();
	}

	// ── 1º: escolhe a config (logo após a lista, casando com a numeração) ────
	const def = syncs.length ? syncs[0].file : "configs/sync.yml";
	const pick = (
		prompt(
			chalk.cyan(t("compose.prompt_config")) +
				chalk.gray(t("compose.prompt_config_hint")),
			def,
		) ?? ""
	).trim();
	const byIndex = syncs[Number(pick) - 1];
	const configPath = byIndex ? byIndex.file : pick;
	if (!configPath) {
		console.log(chalk.red(t("compose.config_required")));
		process.exit(1);
	}
	if (!existsSync(configPath)) {
		console.log(
			chalk.yellowBright(t("compose.config_not_exist", { path: configPath })),
		);
	}

	// ── 2º: nome/sufixo do container da nova instância ───────────────────────
	const suffix = (
		prompt(
			chalk.cyan(t("compose.prompt_suffix")) +
				chalk.gray(t("compose.prompt_suffix_hint")),
			nextSuffix(committed.names),
		) ?? ""
	).trim();
	if (!suffix) {
		console.log(chalk.red(t("compose.suffix_required")));
		process.exit(1);
	}

	// ── recursos recomendados (com base no que já está comprometido) ─────────
	const rec = recommendResources(
		totalRam,
		cores,
		committed.mem,
		committed.cpus,
	);
	console.log(
		`\n${chalk.bold.cyan(t("compose.suggested_resources"))} ${chalk.gray(t("compose.suggested_resources_hint"))}`,
	);
	console.log(
		`    mem_limit/memswap ${chalk.greenBright(`${rec.memLimitMiB}m`)} · ` +
			`mem_reservation ${chalk.greenBright(`${rec.memReservMiB}m`)} · ` +
			`cpus ${chalk.greenBright(String(rec.cpus))}`,
	);
	console.log(chalk.gray(t("compose.resource_mode_hint")));
	const mode = (
		prompt(chalk.cyan(t("compose.prompt_option")), "1") ?? "1"
	).trim();

	const res =
		mode === "2"
			? {
					memLimitMiB: numOr(
						prompt("mem_limit (MiB):", String(rec.memLimitMiB)),
						rec.memLimitMiB,
					),
					memReservMiB: numOr(
						prompt("mem_reservation (MiB):", String(rec.memReservMiB)),
						rec.memReservMiB,
					),
					cpus: numOr(
						prompt(t("compose.prompt_cpus"), String(rec.cpus)),
						rec.cpus,
					),
				}
			: rec;

	// ── gera o compose ───────────────────────────────────────────────────────
	const outSrc = buildInstanceCompose(readFileSync(BASE_FILE, "utf8"), {
		suffix,
		configPath,
		res,
	});
	const outFile = `docker-compose-limit-${suffix}.yml`;
	writeFileSync(outFile, outSrc);

	console.log(
		`\n${chalk.bold.green(t("compose.generated", { file: outFile }))}`,
	);
	console.log(
		t("compose.generated_detail", {
			container: `pulsar-sync-${suffix}`,
			config: configPath,
			logs: `./logs-${suffix}`,
			mem: res.memLimitMiB,
			cpus: res.cpus,
		}),
	);

	if (confirm(t("compose.confirm_up", { file: outFile }))) {
		try {
			execSync(`docker compose -f ${outFile} up -d --build`, {
				stdio: "inherit",
			});
			console.log(
				chalk.green(t("compose.up_ok", { suffix })) +
					chalk.gray(t("compose.up_ok_logs", { suffix })),
			);
		} catch {
			console.log(chalk.red(t("compose.up_fail")));
			process.exit(1);
		}
	} else {
		console.log(chalk.gray(t("compose.up_later", { file: outFile })));
	}
}
