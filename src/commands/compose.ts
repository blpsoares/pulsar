import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { buildInstanceCompose } from "../core/compose/buildCompose";
import { detectConfigs } from "../core/compose/detectConfigs";
import { recommendResources } from "../core/compose/recommend";

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
			chalk.red(`✗ Não achei ${BASE_FILE} no diretório atual.`) +
				chalk.gray(" Rode na raiz do repo do pulsar."),
		);
		process.exit(1);
	}

	const cores = os.cpus().length || 1;
	const totalRam = os.totalmem();
	const usedRam = totalRam - os.freemem();
	const committed = committedResources();

	console.log(`\n${chalk.bold.cyan("PULSAR COMPOSE — nova instância")}`);
	console.log(chalk.gray("─".repeat(58)));
	console.log(
		`${chalk.gray("Instâncias existentes:")} ${
			committed.names.length
				? chalk.yellowBright(committed.names.join(", "))
				: chalk.gray("nenhuma")
		}`,
	);
	console.log(
		`${chalk.gray("RAM:")} total ${chalk.greenBright(`${(totalRam / GiB).toFixed(1)}G`)} · ` +
			`em uso (SO) ${chalk.yellow(`${(usedRam / GiB).toFixed(1)}G`)} · ` +
			`comprometida p/ pulsar ${chalk.yellow(`${(committed.mem / GiB).toFixed(1)}G`)}`,
	);
	console.log(
		`${chalk.gray("CPU:")} ${chalk.yellowBright(String(cores))} núcleo(s) · comprometidos ${chalk.yellow(String(committed.cpus))}\n`,
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
		console.log(chalk.bold("Configs de sync encontradas:"));
		syncs.forEach((c, i) => {
			console.log(
				`  ${chalk.cyan(String(i + 1))}) ${c.file} ` +
					chalk.gray(`→ destino: ${c.destDb ?? "?"}`),
			);
		});
		const others = found.filter(
			(c) => c.kind !== "sync" && c.kind !== "desconhecido",
		);
		if (others.length) {
			console.log(
				chalk.gray(
					`  (ignoradas p/ sync: ${others.map((o) => `${o.file}[${o.kind}]`).join(", ")})`,
				),
			);
		}
		console.log();
	}

	const suffix = (
		prompt(
			chalk.cyan("Sufixo da instância") +
				chalk.gray(" (ex.: 2 → pulsar-sync-2):"),
			nextSuffix(committed.names),
		) ?? ""
	).trim();
	if (!suffix) {
		console.log(chalk.red("Sufixo obrigatório. Abortado."));
		process.exit(1);
	}

	const def = syncs.length ? syncs[0].file : `configs/sync${suffix}.yml`;
	const pick = (
		prompt(
			chalk.cyan("Config (nº da lista ou caminho)") +
				chalk.gray(" — DEVE apontar p/ outro destino:"),
			def,
		) ?? ""
	).trim();
	const byIndex = syncs[Number(pick) - 1];
	const configPath = byIndex ? byIndex.file : pick;
	if (!configPath) {
		console.log(chalk.red("Config obrigatória. Abortado."));
		process.exit(1);
	}
	if (!existsSync(configPath)) {
		console.log(
			chalk.yellowBright(
				`⚠ ${configPath} ainda não existe — crie antes de subir (URI/destino próprios).`,
			),
		);
	}

	// ── recursos recomendados (com base no que já está comprometido) ─────────
	const rec = recommendResources(
		totalRam,
		cores,
		committed.mem,
		committed.cpus,
	);
	console.log(
		`\n${chalk.bold.cyan("Recursos sugeridos")} ${chalk.gray("(disponível − em uso → recomendado)")}`,
	);
	console.log(
		`    mem_limit/memswap ${chalk.greenBright(`${rec.memLimitMiB}m`)} · ` +
			`mem_reservation ${chalk.greenBright(`${rec.memReservMiB}m`)} · ` +
			`cpus ${chalk.greenBright(String(rec.cpus))}`,
	);
	console.log(
		chalk.gray("  [1] usar recomendados (Enter)   [2] inserir manualmente"),
	);
	const mode = (prompt(chalk.cyan("Opção:"), "1") ?? "1").trim();

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
					cpus: numOr(prompt("cpus (núcleos):", String(rec.cpus)), rec.cpus),
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

	console.log(`\n${chalk.bold.green(`✓ Gerado ${outFile}`)}`);
	console.log(
		chalk.gray("  container ") +
			chalk.bold(`pulsar-sync-${suffix}`) +
			chalk.gray(" · config ") +
			chalk.bold(configPath) +
			chalk.gray(" · logs ") +
			chalk.bold(`./logs-${suffix}`) +
			chalk.gray(` · ${res.memLimitMiB}m/${res.cpus}cpu`),
	);

	if (confirm(`Subir agora (docker compose -f ${outFile} up -d --build)?`)) {
		try {
			execSync(`docker compose -f ${outFile} up -d --build`, {
				stdio: "inherit",
			});
			console.log(
				chalk.green(`\n✓ pulsar-sync-${suffix} no ar.`) +
					chalk.gray(` Logs: docker logs -f pulsar-sync-${suffix}`),
			);
		} catch {
			console.log(
				chalk.red(
					"\n✗ Falha ao subir — verifique o Docker e o compose gerado.",
				),
			);
			process.exit(1);
		}
	} else {
		console.log(
			chalk.gray(`\nQuando quiser: docker compose -f ${outFile} up -d --build`),
		);
	}
}
