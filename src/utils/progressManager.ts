import chalk from "chalk";
import { MultiBar } from "cli-progress";

let _multiBar: MultiBar | null = null;
let _total = 0;
let _done = 0;
let _pending: string[] = [];

const barFormat =
	`${chalk.cyan("{collection}")} ⟬{bar}⟭ {percentage}% ` +
	`| {value}/{total} ` +
	`| ${chalk.gray("↷ {skip} skip")} ` +
	`| ${chalk.yellow("✎ {upd} upd")} ` +
	`| ${chalk.green("⊕ {ins} ins")} ` +
	`| ⧖ {duration_formatted}`;

function getMultiBar(): MultiBar {
	if (!_multiBar) {
		_multiBar = new MultiBar({
			format: barFormat,
			barCompleteChar: "█",
			barIncompleteChar: "░",
			barsize: 24,
			hideCursor: true,
			clearOnComplete: false,
			stopOnComplete: false,
			linewrap: false,
			forceRedraw: true,
			autopadding: true,
		});
	}
	return _multiBar;
}

/** Reset state for a new sync run with the expected number of collections. */
export function initProgress(total: number) {
	_total = total;
	_done = 0;
	_pending = [];
}

export function createBar(collectionName: string, total: number) {
	return getMultiBar().create(total, 0, {
		collection: collectionName,
		skip: 0,
		upd: 0,
		ins: 0,
	});
}

/**
 * Mark one collection as fully processed. Finished bars are kept on screen
 * (frozen at 100%) so nothing disappears. Once every expected collection is
 * done, the MultiBar is stopped and any queued logs are flushed in order.
 */
export function markDone() {
	_done++;
	if (_total > 0 && _done >= _total) {
		if (_multiBar) {
			_multiBar.stop();
			_multiBar = null;
		}
		flush();
		_total = 0;
		_done = 0;
	}
}

function flush() {
	for (const msg of _pending) process.stdout.write(`${msg}\n`);
	_pending = [];
}

/**
 * Encerra a MultiBar e despeja logs pendentes — chamado ao fim do startup do
 * sync. Necessário porque collections que RETOMAM (resume, sem dump) não
 * chamam `markDone`, então o contador `_done` pode nunca alcançar `_total`.
 * Idempotente: se as barras já pararam (caso 100% dump), é no-op.
 */
export function finishProgress() {
	if (_multiBar) {
		_multiBar.stop();
		_multiBar = null;
	}
	flush();
	_total = 0;
	_done = 0;
}

/**
 * Print a line immediately above the live bars (cli-progress sabe redesenhar as
 * barras por baixo). Quando não há barras (não-TTY/pm2), cai num console.log
 * normal. Use para mensagens que precisam aparecer NA HORA, sem esperar o fim.
 */
export function logAboveBars(message: string) {
	if (_multiBar) _multiBar.log(`${message}\n`);
	else console.log(message);
}

/**
 * Print a log line without corrupting the live MultiBar render. While bars are
 * on screen the message is queued and flushed once they're gone.
 */
export function multiLog(message: string) {
	if (_multiBar) {
		_pending.push(message);
	} else {
		console.log(message);
	}
}

// ─── STATUS heartbeat (modo NÃO-TTY: container/pm2/systemd) ───────────────────
// Sem barras, o operador fica cego no `docker logs`. Este reporter imprime a cada
// N segundos um bloco consolidado: barra de texto + % + docs de cada dump ativo
// (até `-p`), mais contadores. Legível mesmo SEM cor (chalk desliga cor fora de
// TTY) graças aos blocos █░ e à régua ━.
type ActiveDump = { processed: number; total: number };
const _activeDumps = new Map<string, ActiveDump>();
let _statusTimer: ReturnType<typeof setInterval> | null = null;
let _dumpsDone = 0;
let _collsTotal = 0;

/** Registra/atualiza um dump em andamento (chamado pelo dumpEvent). */
export function trackDumpStart(collection: string, total: number) {
	_activeDumps.set(collection, { processed: 0, total });
}
export function trackDumpProgress(
	collection: string,
	processed: number,
	total: number,
) {
	_activeDumps.set(collection, { processed, total });
}
export function trackDumpDone(collection: string) {
	if (_activeDumps.delete(collection)) _dumpsDone++;
}

/** 12000 → "12.0k", 1500000 → "1.5M". */
function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Barra de texto █░ de `width` chars a partir de um %. */
function textBar(pct: number, width = 22): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function printStatus() {
	if (_activeDumps.size === 0) return;
	const W = 64;
	const out: string[] = [];
	out.push(chalk.cyan("━".repeat(W)));
	out.push(chalk.bold.cyan("  SYNC · DUMP INICIAL"));
	for (const [name, { processed, total }] of _activeDumps) {
		const pct =
			total > 0 ? Math.min(100, Math.floor((processed / total) * 100)) : 0;
		const label =
			name.length > 24 ? `${name.slice(0, 23)}…` : name.padEnd(24);
		const counts = `${fmtNum(processed)}/${fmtNum(total)}`;
		out.push(
			`  ${chalk.white(label)} ${chalk.green(textBar(pct))} ` +
				`${chalk.yellowBright(`${String(pct).padStart(3)}%`)}  ${chalk.gray(counts)}`,
		);
	}
	out.push(
		chalk.gray(
			`  concluídos: ${_dumpsDone}  ·  em andamento: ${_activeDumps.size}  ·  total de collections: ${_collsTotal}`,
		),
	);
	out.push(chalk.cyan("━".repeat(W)));
	console.log(out.join("\n"));
}

/** Liga o heartbeat (só faz sentido em não-TTY). intervalMs<=0 desliga. */
export function startStatusReporter(totalCollections: number, intervalMs: number) {
	_collsTotal = totalCollections;
	_dumpsDone = 0;
	if (_statusTimer || intervalMs <= 0) return;
	_statusTimer = setInterval(printStatus, intervalMs);
	_statusTimer.unref?.();
}

/** Desliga o heartbeat e limpa o estado (fim do dump inicial ou shutdown). */
export function stopStatusReporter() {
	if (_statusTimer) {
		clearInterval(_statusTimer);
		_statusTimer = null;
	}
	_activeDumps.clear();
}
