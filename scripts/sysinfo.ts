/**
 * Mostra os recursos da máquina (CPU, RAM, swap, disco), EXPLICA o que é cada
 * limite ajustável e CALCULA os valores sugeridos pro docker-compose-limit.yml.
 *
 *     bun run sys:info            # só mostra (recursos + explicação + sugestão)
 *     bun run sys:info --apply    # ALÉM disso, grava os valores no compose
 *
 * As sugestões seguem a regra de bolso: ~65% da RAM pro container (folga pro SO),
 * swap proibido (memswap == mem_limit), reserva ~50% do limite, e deixar ~1
 * núcleo livre. São PONTO DE PARTIDA — calibre com `docker stats` rodando.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;
const APPLY = process.argv.slice(2).includes("--apply");
const COMPOSE_PATH = fileURLToPath(
	new URL("../docker-compose-limit.yml", import.meta.url),
);

/** Formata bytes em GiB com 2 casas (ou MiB se < 1 GiB). */
function human(bytes: number): string {
	if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
	return `${Math.round(bytes / MiB)} MiB`;
}

/** Lê SwapTotal do /proc/meminfo (Linux). Retorna bytes, ou null se indisponível. */
function swapTotalBytes(): number | null {
	try {
		const meminfo = readFileSync("/proc/meminfo", "utf8");
		const match = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
		return match ? Number(match[1]) * 1024 : null;
	} catch {
		return null;
	}
}

/** Espaço livre em "/" via df (KiB → bytes). Retorna null fora do Linux/macOS. */
function diskFreeBytes(): number | null {
	try {
		const out = execSync("df -k /", { encoding: "utf8" }).trim().split("\n");
		const fields = out[out.length - 1].split(/\s+/);
		// Filesystem 1K-blocks Used Available Use% Mounted → Available = idx 3
		return Number(fields[3]) * 1024;
	} catch {
		return null;
	}
}

/** Substitui o valor de uma chave YAML (preserva indentação/comentários acima). */
function setYamlValue(
	src: string,
	key: string,
	value: string,
): { src: string; ok: boolean } {
	const re = new RegExp(`^(\\s*${key}:\\s*).*$`, "m");
	if (!re.test(src)) return { src, ok: false };
	return { src: src.replace(re, `$1${value}`), ok: true };
}

const cpus = os.cpus();
const cores = cpus.length || 1;
const cpuModel = cpus[0]?.model?.trim() ?? "desconhecido";
const totalRam = os.totalmem();
const freeRam = os.freemem();
const swap = swapTotalBytes();
const disk = diskFreeBytes();

// ── sugestões pro compose ───────────────────────────────────────────────────
const memLimitMiB = Math.floor((totalRam * 0.65) / MiB); // ~65% da RAM
const memReservMiB = Math.floor(memLimitMiB * 0.5); // ~50% do limite
// deixa ~1 núcleo livre; em máquinas de 1-2 núcleos, meio núcleo.
const recCpus = cores <= 2 ? Math.max(1, cores - 0.5) : cores - 1;

const line = chalk.gray("─".repeat(60));
const label = (s: string) => chalk.gray(s.padEnd(20));

console.log(`\n${chalk.bold.cyan("RECURSOS DA MÁQUINA")}`);
console.log(line);
console.log(`${label("Host / plataforma")}${os.hostname()} · ${os.platform()}/${os.arch()}`);
console.log(`${label("CPU")}${chalk.yellowBright(String(cores))} núcleo(s) — ${cpuModel}`);
console.log(`${label("RAM total")}${chalk.greenBright(human(totalRam))}  (livre agora: ${human(freeRam)})`);
console.log(`${label("Swap")}${swap === null ? "n/d" : swap === 0 ? chalk.green("0 (sem swap — ok)") : human(swap)}`);
console.log(`${label("Disco livre em /")}${disk === null ? "n/d" : human(disk)}`);

// ── o que é cada limite ──────────────────────────────────────────────────────
console.log(`\n${chalk.bold.cyan("O QUE É CADA LIMITE AJUSTÁVEL")}`);
console.log(line);
const knob = (name: string, desc: string) =>
	console.log(`${chalk.greenBright(name.padEnd(16))}${desc}`);
knob(
	"mem_limit",
	chalk.white("TETO DURO de RAM.") +
		chalk.gray(" Máx que o container pode usar. Bateu nele →"),
);
console.log(`${" ".repeat(16)}${chalk.gray("kernel mata o container (OOM). É \"a parede\" que protege a VM.")}`);
knob(
	"memswap_limit",
	chalk.white("TETO de RAM + swap juntos.") + chalk.gray(" Igual ao mem_limit →"),
);
console.log(`${" ".repeat(16)}${chalk.gray("swap PROIBIDO. Se fosse maior, a diferença seria quanto de swap")}`);
console.log(`${" ".repeat(16)}${chalk.gray("(disco) ele poderia usar — e swap em disco TRAVA a VM por I/O.")}`);
knob(
	"mem_reservation",
	chalk.white("PISO MACIO (não é teto).") + chalk.gray(" Quanto o container"),
);
console.log(`${" ".repeat(16)}${chalk.gray("\"reserva\". Sob disputa de RAM, o kernel preserva isto e tira")}`);
console.log(`${" ".repeat(16)}${chalk.gray("primeiro de quem passou da própria reserva. Pode ultrapassar")}`);
console.log(`${" ".repeat(16)}${chalk.gray("quando sobra RAM. Defina ABAIXO do mem_limit.")}`);
knob(
	"cpus",
	chalk.white("Máx de núcleos de CPU.") +
		chalk.gray(" Aceita fração: 1.5 = um núcleo e meio."),
);

// ── sugestão / aplicação ─────────────────────────────────────────────────────
console.log(`\n${chalk.bold.cyan("SUGESTÃO PRO docker-compose-limit.yml")}`);
console.log(chalk.gray("(ponto de partida — calibre com `docker stats` rodando)"));
console.log(line);
console.log(
	chalk.white(
		`    mem_limit: ${chalk.greenBright(`${memLimitMiB}m`)}` +
			chalk.gray("        # ~65% da RAM, deixa folga pro SO\n") +
			`    memswap_limit: ${chalk.greenBright(`${memLimitMiB}m`)}` +
			chalk.gray("    # == mem_limit, proíbe swap\n") +
			`    mem_reservation: ${chalk.greenBright(`${memReservMiB}m`)}` +
			chalk.gray("   # ~50% do limite (alvo macio)\n") +
			`    cpus: ${chalk.greenBright(String(recCpus))}` +
			chalk.gray(`             # deixa ~1 núcleo livre (de ${cores})`),
	),
);

if (disk !== null && disk < 5 * GiB) {
	console.log(
		`\n${chalk.yellowBright("⚠ Disco livre baixo")} — considere reduzir LOG_MAX_SIZE/LOG_MAX_FILES no compose.`,
	);
}

if (APPLY) {
	try {
		let src = readFileSync(COMPOSE_PATH, "utf8");
		const edits: Array<[string, string]> = [
			["mem_limit", `${memLimitMiB}m`],
			["memswap_limit", `${memLimitMiB}m`],
			["mem_reservation", `${memReservMiB}m`],
			["cpus", String(recCpus)],
		];
		const missing: string[] = [];
		for (const [key, value] of edits) {
			const res = setYamlValue(src, key, value);
			if (!res.ok) missing.push(key);
			src = res.src;
		}
		writeFileSync(COMPOSE_PATH, src);
		console.log(`\n${chalk.bold.green("✓ Valores gravados em docker-compose-limit.yml")}`);
		if (missing.length) {
			console.log(
				chalk.yellowBright(`  (não achei as chaves: ${missing.join(", ")} — confira o arquivo)`),
			);
		}
		console.log(chalk.gray("  Revise o diff antes de commitar: git diff docker-compose-limit.yml"));
	} catch (err) {
		console.log(
			`\n${chalk.red("✗ Falha ao gravar no compose:")} ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
} else {
	console.log(
		`\n${chalk.gray("Pra gravar esses valores no compose automaticamente:")} ${chalk.cyan("bun run sys:info --apply")}`,
	);
}
console.log();
