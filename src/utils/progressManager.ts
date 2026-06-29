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
// Plano do run: quantas RESUMIRAM (pularam dump, mantidas pelo watch) vs quantas
// precisam de dump. Sem isto o STATUS mostrava "concluídos: 1 / 54" e parecia que
// 53 estavam paradas — quando na verdade resumiram pelo token.
let _resuming = 0;
let _dumpsPlanned = 0;

/** Informado pelo engine após decidir resume-vs-dump por collection. */
export function setSyncPlan(resuming: number, dumpsPlanned: number) {
	_resuming = resuming;
	_dumpsPlanned = dumpsPlanned;
}

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
		const label = name.length > 24 ? `${name.slice(0, 23)}…` : name.padEnd(24);
		const counts = `${fmtNum(processed)}/${fmtNum(total)}`;
		out.push(
			`  ${chalk.white(label)} ${chalk.green(textBar(pct))} ` +
				`${chalk.yellowBright(`${String(pct).padStart(3)}%`)}  ${chalk.gray(counts)}`,
		);
	}
	out.push(
		chalk.gray(
			`  resumidas (sem dump, mantidas pelo watch): ${_resuming}  ·  ` +
				`dump concluído: ${_dumpsDone}/${_dumpsPlanned}  ·  ` +
				`em andamento: ${_activeDumps.size}  ·  total: ${_collsTotal}`,
		),
	);
	out.push(chalk.cyan("━".repeat(W)));
	console.log(out.join("\n"));
}

/** Liga o heartbeat (só faz sentido em não-TTY). intervalMs<=0 desliga. */
export function startStatusReporter(
	totalCollections: number,
	intervalMs: number,
) {
	_collsTotal = totalCollections;
	_dumpsDone = 0;
	if (_statusTimer || intervalMs <= 0) return;
	_statusTimer = setInterval(printStatus, intervalMs);
	_statusTimer.unref?.();
}

/**
 * Painel de fechamento (1×) impresso na transição dump→watch. Texto puro (sem
 * cor) p/ alinhar igual em TTY e no docker logs; os caracteres de caixa e ↳/·
 * renderizam em qualquer terminal. Largura fixa, conteúdo padded por code point.
 */
export function renderClosingPanel(d: {
	total: number;
	resumed: number;
	dumped: number;
	dumpedNames: string[];
	failed: string[];
	docsDumped: number;
	durationMs: number;
	stopHint: string;
	indexes?: {
		created: number;
		skipped: number;
		failed: { coll: string; name: string }[];
	};
	views?: {
		created: number;
		updated: number;
		skipped: number;
		failed: { name: string; reason: string }[];
	};
}): string {
	const num = (n: number) => n.toLocaleString("pt-BR");
	const dur = (ms: number) => {
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return `${m}m ${s % 60}s`;
	};
	const dumpedLabel =
		d.dumpedNames.length > 0 ? `  (${d.dumpedNames.join(", ")})` : "";

	const title = "PULSAR · SINCRONIZAÇÃO INICIAL CONCLUÍDA";
	const mode = "MODO: tempo real · replicando mudanças ao vivo";

	// Corpo (texto puro de cada linha, sem bordas) — coletado ANTES pra calcular a
	// largura dinâmica que cabe o maior conteúdo (ex.: lista de collections cujos
	// índices falharam) sem truncar.
	const body: string[] = [
		`Collections em dia ........ ${d.total - d.failed.length}/${d.total}`,
		`  ↳ retomadas (delta) ..... ${d.resumed}`,
		`  ↳ dump completo ......... ${d.dumped}${dumpedLabel}`,
	];
	if (d.failed.length > 0) {
		body.push(
			`  ↳ FALHARAM (re-dump) .... ${d.failed.length} (${d.failed.join(", ")})`,
		);
	}
	body.push(
		`Docs copiados no dump ..... ${num(d.docsDumped)}`,
		`Duração ................... ${dur(d.durationMs)}`,
	);
	if (d.indexes) {
		const f = d.indexes.failed;
		const fLabel =
			f.length > 0
				? ` · falharam: ${f.length} (${[...new Set(f.map((x) => x.coll))].join(", ")})`
				: "";
		body.push(
			`Índices ... criados: ${d.indexes.created} · já existiam: ${d.indexes.skipped}${fLabel}`,
		);
	}
	if (d.views) {
		const f = d.views.failed;
		const fLabel =
			f.length > 0
				? ` · falharam: ${f.length} (${f.map((x) => x.name).join(", ")})`
				: "";
		body.push(
			`Views ..... criadas: ${d.views.created} · atualizadas: ${d.views.updated} · iguais: ${d.views.skipped}${fLabel}`,
		);
	}

	// Largura dinâmica: cabe o maior conteúdo (+1 do espaço à esquerda do row()),
	// entre um mínimo legível (54) e um teto (120) pra não estourar o terminal.
	const MIN_W = 54;
	const MAX_W = 120;
	const needed = Math.max(
		...[title, mode, d.stopHint, ...body].map((s) => [...s].length + 1),
	);
	const W = Math.min(MAX_W, Math.max(MIN_W, needed));

	const row = (s: string) => {
		let content = ` ${s}`;
		const cps = [...content];
		// trunca só se passar do TETO (a largura já cresceu pro conteúdo normal)
		if (cps.length > W) content = `${cps.slice(0, W - 1).join("")}…`;
		const len = [...content].length;
		return `║${content}${" ".repeat(Math.max(0, W - len))}║`;
	};

	return [
		`╔${"═".repeat(W)}╗`,
		row(title),
		`╠${"═".repeat(W)}╣`,
		...body.map(row),
		`║${"─".repeat(W)}║`,
		row(mode),
		row(d.stopHint),
		`╚${"═".repeat(W)}╝`,
	].join("\n");
}

// ─── Heartbeat do WATCH contínuo (24/7, não-TTY) ─────────────────────────────
// Depois do dump, o log fica mudo. Este heartbeat imprime a cada N segundos um
// bloco esparso com uptime + eventos (total/por tipo/top collections), provando
// que está vivo sem poluir. Quieto = 1 linha só.
export type WatchSnapshot = {
	uptimeMs: number;
	totals: { insert: number; update: number; replace: number; delete: number };
	perColl: Array<[string, number]>; // já ordenado desc
};

let _watchTimer: ReturnType<typeof setInterval> | null = null;

function fmtUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

function renderWatchBlock(s: WatchSnapshot): string {
	const total =
		s.totals.insert + s.totals.update + s.totals.replace + s.totals.delete;
	const num = (n: number) => n.toLocaleString("pt-BR");
	const head = `──── PULSAR · WATCH ATIVO ──── uptime ${fmtUptime(s.uptimeMs)}`;
	if (total === 0) {
		return `${head} · 0 eventos (origem quieta)`;
	}
	const TOP = 8;
	const top = s.perColl.slice(0, TOP).map(([c, n]) => `${c} ${num(n)}`);
	const rest = s.perColl.length - TOP;
	const topLine =
		`   mais ativas: ${top.join(" · ")}` + (rest > 0 ? `  (+${rest})` : "");
	return [
		head,
		` eventos: ${num(total)}  (ins ${num(s.totals.insert)} · upd ${num(s.totals.update)} · rep ${num(s.totals.replace)} · del ${num(s.totals.delete)})`,
		topLine,
	].join("\n");
}

/** Liga o heartbeat do watch (não-TTY). intervalMs<=0 desliga. */
export function startWatchHeartbeat(
	intervalMs: number,
	snapshot: () => WatchSnapshot,
) {
	if (_watchTimer || intervalMs <= 0) return;
	_watchTimer = setInterval(
		() => console.log(renderWatchBlock(snapshot())),
		intervalMs,
	);
	_watchTimer.unref?.();
}

export function stopWatchHeartbeat() {
	if (_watchTimer) {
		clearInterval(_watchTimer);
		_watchTimer = null;
	}
}

/** Desliga o heartbeat e limpa o estado (fim do dump inicial ou shutdown). */
export function stopStatusReporter() {
	if (_statusTimer) {
		clearInterval(_statusTimer);
		_statusTimer = null;
	}
	_activeDumps.clear();
}
