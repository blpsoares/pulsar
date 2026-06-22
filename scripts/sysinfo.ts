/**
 * Mostra os recursos da máquina (CPU, RAM, swap, disco) e CALCULA os valores
 * sugeridos pro docker-compose-limit.yml. Rode na VM antes de definir os limites:
 *
 *     bun run sys:info
 *
 * As sugestões seguem a regra de bolso: ~65% da RAM pro container (folga pro SO),
 * swap proibido (memswap == mem_limit), reserva ~50% do limite, e deixar ~1
 * núcleo livre. São PONTO DE PARTIDA — calibre com `docker stats` rodando.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import chalk from "chalk";

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

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

const line = chalk.gray("─".repeat(58));
const label = (s: string) => chalk.gray(s.padEnd(20));

console.log(`\n${chalk.bold.cyan("RECURSOS DA MÁQUINA")}`);
console.log(line);
console.log(`${label("Host / plataforma")}${os.hostname()} · ${os.platform()}/${os.arch()}`);
console.log(`${label("CPU")}${chalk.yellowBright(String(cores))} núcleo(s) — ${cpuModel}`);
console.log(`${label("RAM total")}${chalk.greenBright(human(totalRam))}  (livre agora: ${human(freeRam)})`);
console.log(`${label("Swap")}${swap === null ? "n/d" : swap === 0 ? chalk.green("0 (sem swap — ok)") : human(swap)}`);
console.log(`${label("Disco livre em /")}${disk === null ? "n/d" : human(disk)}`);

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
console.log();
