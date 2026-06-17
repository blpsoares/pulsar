import { MultiBar } from "cli-progress";
import chalk from "chalk";

let _multiBar: MultiBar | null = null;
let _activeCount = 0;
let _pendingLogs: string[] = [];

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
			hideCursor: true,
			clearOnComplete: false,
			autopadding: true,
		});
	}
	return _multiBar;
}

export function createBar(collectionName: string, total: number) {
	_activeCount++;
	return getMultiBar().create(total, 0, {
		collection: collectionName,
		skip: 0,
		upd: 0,
		ins: 0,
	});
}

export function removeBar(bar: ReturnType<MultiBar["create"]>) {
	_multiBar?.remove(bar);
	_activeCount--;

	if (_activeCount <= 0) {
		_multiBar?.stop();
		_multiBar = null;
		_activeCount = 0;
		for (const msg of _pendingLogs) {
			process.stdout.write(`${msg}\n`);
		}
		_pendingLogs = [];
	}
}

export function multiLog(message: string) {
	if (_activeCount > 0) {
		_pendingLogs.push(message);
	} else {
		console.log(message);
	}
}
