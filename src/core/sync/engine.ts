import Bottleneck from "bottleneck";
import type {
	ChangeStream,
	ChangeStreamDocument,
	Collection,
	Db,
	Document,
	ResumeToken,
} from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { customLog, logger } from "../../utils/customLog";
import { setSyncPlan } from "../../utils/progressManager";
import { ensureCollectionIndexes } from "./copyIndexes";
import { buildDbWatchPipeline } from "./dbWatchPipeline";
import { watchDeleteEvent } from "./deleteEvent";
import { dumpCollections } from "./dumpEvent";
import { watchInsertEvent } from "./insertEvent";
import { watchReplaceEvent } from "./replaceEvent";
import { decideStartupAction, isHistoryLostError } from "./restartDecision";
import { ResumeTokenCheckpointer } from "./resumeCheckpointer";
import {
	loadDbResumeToken,
	loadSyncState,
	markDumpCompleted,
	saveDbResumeToken,
	saveDumpProgress,
} from "./syncState";
import { watchUpdateEvent } from "./updateEvent";

const DEFAULT_PARALLEL = 3;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CHECKPOINT_MS = 5000;
const RESUME_REOPEN_MS = 5000;
const RESUME_PROBE_MS = 1500;

export type EngineCollection = { name: string; filter?: Document };

export type SyncEngineOptions = {
	sourceDb: Db;
	destDb: Db;
	collections: EngineCollection[];
	parallel?: number;
	batchSize?: number;
	full?: boolean;
	checkpointIntervalMs?: number;
	/** Janela máx. p/ considerar um resume estabelecido (e p/ aguardar token). */
	resumeProbeMs?: number;
	/** Replicar no destino os índices secundários da origem (default false). */
	copyIndexes?: boolean;
};

type Route = { srcCol: Collection; destCol: Collection; filter?: Document };

/**
 * Determina se um erro de um stream em modo RESUME torna o resume impossível
 * (token expirado/oplog estourado, ou token inutilizável) → caímos no dump.
 * Em produção o caso real é o 286; o resto cobre tokens corrompidos.
 */
function isResumeImpossibleError(err: unknown): boolean {
	if (isHistoryLostError(err)) return true;
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: number; message?: string };
	if (e.code === 50811) return true; // KeyString format error (token inválido)
	return /resume|KeyString|changeStreamHistoryLost/i.test(
		String(e.message ?? ""),
	);
}

/**
 * Orquestra o `sync` com UM ÚNICO change stream no banco (`db.watch`) — uma
 * conexão escuta todas as collections configuradas (em vez de 1 por collection),
 * matando a saturação de conexões. Cada evento é roteado por `ns.coll` pro
 * destino certo. O dump de cada collection decide entre RETOMAR (pula o dump,
 * o stream já cobre as mudanças) ou DUMPAR (do zero ou da fronteira salva).
 *
 * Instância isolada (sem estado global) — pode ser parada e recriada no mesmo
 * processo (essencial pros testes de restart).
 */
export class SyncEngine {
	private readonly opts: Required<Omit<SyncEngineOptions, "collections">> & {
		collections: EngineCollection[];
	};
	private readonly routes = new Map<string, Route>();
	private readonly deletedIds: string[] = [];
	/** Collections cujo dump inicial FALHOU (após esgotar retries). */
	readonly failedDumps: string[] = [];
	/** Quantas resumiram (pularam dump) e quantas precisaram de dump neste run. */
	resumedCount = 0;
	dumpsPlanned = 0;
	/** Total de docs escritos no dump (insert+update) e nomes dumpados — p/ o painel. */
	docsDumped = 0;
	readonly dumpedNames: string[] = [];
	/** Cópia de índices (quando copyIndexes on): agregados p/ o painel final. */
	indexesCreated = 0;
	indexesSkipped = 0;
	readonly indexFailures: { coll: string; name: string }[] = [];
	/** Contadores de eventos do watch (p/ o heartbeat): por collection e por tipo. */
	readonly eventCounts = new Map<string, number>();
	readonly eventTotals = { insert: 0, update: 0, replace: 0, delete: 0 };
	/** `deletedIds` só serve durante o dump (corrida). Após os dumps vira false e
	 * paramos de acumular — senão a lista cresceria 1 entrada por delete pra
	 * sempre no watch 24/7 (vazamento lento). */
	private dumpsActive = true;
	private readonly lastDumpSaveAt = new Map<string, number>();
	/** Última fronteira de cada dump em andamento (p/ flush final no stop). */
	private readonly lastFrontier = new Map<string, unknown>();
	private stream: ChangeStream | null = null;
	private checkpointer: ResumeTokenCheckpointer | null = null;
	private lastToken: ResumeToken | undefined;
	private closed = false;
	/** Sinaliza ao probe do openStream que o resume caiu no 286 (→ re-dump). */
	private resumeLost = false;

	constructor(options: SyncEngineOptions) {
		this.opts = {
			sourceDb: options.sourceDb,
			destDb: options.destDb,
			collections: options.collections,
			parallel: options.parallel ?? DEFAULT_PARALLEL,
			batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
			full: options.full ?? false,
			checkpointIntervalMs:
				options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_MS,
			resumeProbeMs: options.resumeProbeMs ?? RESUME_PROBE_MS,
			copyIndexes: options.copyIndexes ?? false,
		};
		for (const col of this.opts.collections) {
			this.routes.set(col.name, {
				srcCol: this.opts.sourceDb.collection(col.name),
				destCol: this.opts.destDb.collection(col.name),
				filter: col.filter,
			});
		}
	}

	/**
	 * Abre o stream único, decide por collection (resume vs dump) e roda os dumps
	 * (estrangulado por `parallel`). Resolve quando os dumps iniciais terminam; o
	 * stream segue ativo até `stop()`.
	 */
	async start(): Promise<void> {
		const globalToken = this.opts.full
			? undefined
			: await loadDbResumeToken(this.opts.destDb);

		// 1) abre o stream ÚNICO (resume pelo token global, ou fresh). Se o token
		//    expirou (286), forceDumpAll: re-dumpa tudo pra não perder mudanças.
		const forceDumpAll = await this.openStream(globalToken);

		// 2) checkpoint do token global a cada ~5s.
		this.checkpointer = new ResumeTokenCheckpointer(
			() => this.stream?.resumeToken ?? this.lastToken ?? null,
			(t) => saveDbResumeToken(this.opts.destDb, t),
			this.opts.checkpointIntervalMs,
		);
		this.checkpointer.start();

		// 3) decide dump por collection (o stream já cobre o tempo real de todas).
		const effectiveToken = forceDumpAll ? undefined : globalToken;
		const plans = await Promise.all(
			this.opts.collections.map(async (col) => {
				const state = await loadSyncState(this.opts.destDb, col.name);
				const needsDump =
					forceDumpAll ||
					decideStartupAction(
						{
							dumpCompletedAt: state.dumpCompletedAt,
							resumeToken: effectiveToken,
						},
						{ full: this.opts.full },
					) === "dump";
				const resumeFromId =
					this.opts.full || forceDumpAll ? undefined : state.dumpCursorId;
				return { col, needsDump, resumeFromId };
			}),
		);

		// 4) roda os dumps necessários, throttled por -p.
		this.dumpsPlanned = plans.filter((p) => p.needsDump).length;
		this.resumedCount = this.opts.collections.length - this.dumpsPlanned;
		setSyncPlan(this.resumedCount, this.dumpsPlanned);
		const dumpLimiter = new Bottleneck({ maxConcurrent: this.opts.parallel });
		await Promise.all(
			plans
				.filter((p) => p.needsDump)
				.map((p) =>
					dumpLimiter.schedule(() => this.runDump(p.col, p.resumeFromId)),
				),
		);

		// collections que RESUMIRAM (dados já no destino): completa índices faltantes
		// no startup. As que dumparam já trataram índices no runDump.
		if (this.opts.copyIndexes) {
			const resumedCols = plans.filter((p) => !p.needsDump).map((p) => p.col);
			const idxLimiter = new Bottleneck({ maxConcurrent: this.opts.parallel });
			await Promise.all(
				resumedCols.map((c) =>
					idxLimiter.schedule(() => this.copyIndexesFor(c)),
				),
			);
		}

		// dumps concluídos: a lista de deletes-durante-dump não serve mais. Limpa a
		// memória acumulada e desliga o acúmulo (no watch ela só cresceria à toa).
		this.deletedIds.length = 0;
		this.dumpsActive = false;

		// 5) garante o token global persistido (não só no tick de 5s).
		await this.waitForToken(this.opts.resumeProbeMs);
		await this.checkpointer.flush().catch(() => {});
	}

	/** Fecha o stream e faz o flush final do checkpoint. */
	async stop(): Promise<void> {
		this.closed = true;
		if (this.checkpointer) await this.checkpointer.stop();
		// Flush final das fronteiras de dumps AINDA incompletos: na preempção
		// (ACPI/SIGTERM) no meio de um dump, o restart retoma de onde parou em vez
		// de re-escanear o último intervalo de checkpoint. Dumps concluídos já
		// limparam a fronteira (lastFrontier.delete em runDump), então não voltam
		// a ser marcados como incompletos aqui.
		await Promise.all(
			[...this.lastFrontier.entries()].map(([name, id]) =>
				saveDumpProgress(this.opts.destDb, name, id).catch(() => {}),
			),
		);
		if (this.stream) await this.stream.close().catch(() => {});
	}

	/** Garante os índices da origem no destino p/ uma collection; agrega e loga. */
	private async copyIndexesFor(col: EngineCollection): Promise<void> {
		const route = this.routes.get(col.name);
		if (!route) return;
		let res: Awaited<ReturnType<typeof ensureCollectionIndexes>>;
		try {
			res = await ensureCollectionIndexes(route.srcCol, route.destCol);
		} catch (err) {
			// listIndexes da origem falhou → a collection inteira falha na cópia.
			const reason = err instanceof Error ? err.message : String(err);
			this.indexFailures.push({ coll: col.name, name: "*" });
			customLog("warn", `[${col.name}] cópia de índices falhou: ${reason}`);
			return;
		}
		this.indexesCreated += res.created;
		this.indexesSkipped += res.skipped;
		for (const f of res.failed)
			this.indexFailures.push({ coll: col.name, name: f.name });
		const parts = [
			`${res.created} índices criados`,
			`${res.skipped} já existiam`,
		];
		if (res.failed.length > 0) {
			parts.push(
				`${res.failed.length} FALHOU (${res.failed.map((f) => f.name).join(", ")})`,
			);
		}
		customLog("info", `[${col.name}] ${parts.join(", ")}`);
	}

	/** Dump de uma collection: freeze (limpa hot velho) → dump → carimba. */
	private async runDump(
		col: EngineCollection,
		resumeFromId: unknown,
	): Promise<void> {
		const route = this.routes.get(col.name);
		if (!route) return;
		await freezeCollection(route.destCol);
		const ok = await dumpCollections(
			route.srcCol,
			route.destCol,
			this.deletedIds,
			{
				filter: col.filter,
				batchSize: this.opts.batchSize,
				resumeFromId,
				onProgress: (lastId) => this.checkpointDumpProgress(col.name, lastId),
				onDone: (info) => {
					this.docsDumped += info.inserted + info.updated;
					this.dumpedNames.push(col.name);
				},
			},
		);
		if (ok) {
			await markDumpCompleted(this.opts.destDb, col.name);
			// dump concluído: não deve ressuscitar como incompleto no flush do stop.
			this.lastFrontier.delete(col.name);
			// índices DEPOIS do dump: build em lote único é mais rápido que manter
			// índice a cada insert (igual ao mongorestore).
			if (this.opts.copyIndexes) await this.copyIndexesFor(col);
		} else {
			// falhou mesmo após os retries: fica sem dumpCompletedAt (re-dumpa no
			// próximo restart, retomando da fronteira salva) e entra no relatório.
			this.failedDumps.push(col.name);
		}
	}

	/** Salva a fronteira do dump (throttle ~checkpointIntervalMs), fire-and-forget. */
	private checkpointDumpProgress(name: string, lastId: unknown): void {
		// guarda SEMPRE a última fronteira (p/ o flush final no stop); a ESCRITA
		// no Atlas é que fica throttled p/ não martelar o cluster.
		this.lastFrontier.set(name, lastId);
		const now = Date.now();
		if (
			now - (this.lastDumpSaveAt.get(name) ?? 0) <
			this.opts.checkpointIntervalMs
		)
			return;
		this.lastDumpSaveAt.set(name, now);
		void saveDumpProgress(this.opts.destDb, name, lastId).catch(() => {});
	}

	/**
	 * Abre o stream único. Com token global, tenta `startAfter`; se o resume for
	 * impossível (286/token inválido), reabre fresh e devolve `true` (forceDumpAll
	 * — re-dumpa tudo, já que perdemos a posição de todas as collections).
	 */
	private async openStream(
		globalToken: ResumeToken | undefined,
	): Promise<boolean> {
		const pipeline = buildDbWatchPipeline(this.opts.collections);
		if (!globalToken) {
			this.runStream(
				this.opts.sourceDb.watch(pipeline, { fullDocument: "updateLookup" }),
				false,
			);
			return false;
		}
		this.resumeLost = false;
		const stream = this.opts.sourceDb.watch(pipeline, {
			fullDocument: "updateLookup",
			startAfter: globalToken,
		});
		// O pump (for await) começa a consumir JÁ: isso dirige o aggregate (popula
		// o resumeToken rápido, na 1ª resposta do servidor) e aplica eventos com
		// backpressure. Aqui é só PROBE, sem bloquear: resolve assim que o token
		// aparece (resume ok) ou quando o pump sinaliza 286 (resumeLost → re-dump).
		this.runStream(stream, true);
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (force: boolean) => {
				if (settled) return;
				settled = true;
				clearInterval(poll);
				clearTimeout(grace);
				resolve(force);
			};
			const poll = setInterval(() => {
				if (this.resumeLost) done(true);
				else if (this.stream?.resumeToken) done(false);
			}, 50);
			const grace = setTimeout(
				() => done(this.resumeLost),
				this.opts.resumeProbeMs,
			);
		});
	}

	/** Inicia o consumo do stream (roda até stop()). */
	private runStream(stream: ChangeStream, resumeMode: boolean): void {
		this.stream = stream;
		void this.pump(stream, resumeMode);
	}

	/**
	 * Consome o stream com BACKPRESSURE. O `for await` não puxa o próximo lote do
	 * change stream enquanto o apply do evento atual não terminar (`await`). Troca
	 * o antigo `.on('change')` fire-and-forget — que disparava escritas concorrentes
	 * ILIMITADAS e estourava a RAM no replay de backlog — por aplicação serializada
	 * e ORDENADA, com memória presa a ~1 lote. Numa falha transitória reabre com
	 * `startAfter: lastToken` em 5s; no 286 do resume, sinaliza resumeLost e reabre
	 * fresh (o openStream lê isso e força o re-dump de tudo).
	 */
	private async pump(stream: ChangeStream, resumeMode: boolean): Promise<void> {
		try {
			for await (const change of stream) {
				if (this.closed || this.stream !== stream) break;
				this.lastToken = change._id;
				await this.route(change);
			}
		} catch (err) {
			if (this.closed || this.stream !== stream) return;
			const pipeline = buildDbWatchPipeline(this.opts.collections);
			if (resumeMode && isResumeImpossibleError(err)) {
				logger.error(
					"RESUME:db.watch token global inválido/expirado — re-dump de tudo",
				);
				this.resumeLost = true;
				await stream.close().catch(() => {});
				this.runStream(
					this.opts.sourceDb.watch(pipeline, { fullDocument: "updateLookup" }),
					false,
				);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`WATCH:db.watch ${message}. Reabrindo em 5s...`);
			await stream.close().catch(() => {});
			setTimeout(() => {
				if (this.closed || this.stream !== stream) return;
				const next = this.opts.sourceDb.watch(pipeline, {
					fullDocument: "updateLookup",
					...(this.lastToken ? { startAfter: this.lastToken } : {}),
				});
				this.runStream(next, resumeMode);
			}, RESUME_REOPEN_MS);
		}
	}

	/** Roteia o evento pela ns.coll pra collection de destino correspondente. */
	private async route(change: ChangeStreamDocument): Promise<void> {
		const ns = (change as { ns?: { coll?: string } }).ns;
		const coll = ns?.coll;
		if (!coll) return;
		const route = this.routes.get(coll);
		if (!route) return;
		await this.applyEvent(change, route.destCol);
	}

	/** Conta o evento (por collection + por tipo) p/ o heartbeat do watch. */
	private countEvent(
		coll: string,
		op: "insert" | "update" | "replace" | "delete",
	): void {
		this.eventTotals[op]++;
		this.eventCounts.set(coll, (this.eventCounts.get(coll) ?? 0) + 1);
	}

	private async applyEvent(
		change: ChangeStreamDocument,
		destCol: Collection,
	): Promise<void> {
		const coll = destCol.collectionName;
		switch (change.operationType) {
			case "insert":
				this.countEvent(coll, "insert");
				await watchInsertEvent(destCol, change.fullDocument);
				break;
			case "update":
				this.countEvent(coll, "update");
				await watchUpdateEvent(destCol, change.fullDocument);
				break;
			case "replace":
				this.countEvent(coll, "replace");
				await watchReplaceEvent(destCol, change.fullDocument);
				break;
			case "delete":
				this.countEvent(coll, "delete");
				// Durante o dump, registra o delete (evita re-inserir na corrida). No
				// watch, passa um array descartável → nada acumula (sem vazamento).
				await watchDeleteEvent(
					change.documentKey._id as never,
					destCol,
					this.dumpsActive ? this.deletedIds : [],
				);
				break;
			default:
				break;
		}
	}

	private async waitForToken(timeoutMs: number): Promise<void> {
		const start = performance.now();
		while (!this.stream?.resumeToken && !this.lastToken) {
			if (performance.now() - start > timeoutMs) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
}
