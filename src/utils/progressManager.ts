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
