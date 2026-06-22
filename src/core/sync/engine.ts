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
import { logger } from "../../utils/customLog";
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
	private readonly lastDumpSaveAt = new Map<string, number>();
	/** Última fronteira de cada dump em andamento (p/ flush final no stop). */
	private readonly lastFrontier = new Map<string, unknown>();
	private stream: ChangeStream | null = null;
	private checkpointer: ResumeTokenCheckpointer | null = null;
	private lastToken: ResumeToken | undefined;
	private closed = false;

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
		const dumpLimiter = new Bottleneck({ maxConcurrent: this.opts.parallel });
		await Promise.all(
			plans
				.filter((p) => p.needsDump)
				.map((p) =>
					dumpLimiter.schedule(() => this.runDump(p.col, p.resumeFromId)),
				),
		);

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
			},
		);
		if (ok) {
			await markDumpCompleted(this.opts.destDb, col.name);
			// dump concluído: não deve ressuscitar como incompleto no flush do stop.
			this.lastFrontier.delete(col.name);
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
			this.openFresh(pipeline);
			return false;
		}
		const stream = this.opts.sourceDb.watch(pipeline, {
			fullDocument: "updateLookup",
			startAfter: globalToken,
		});
		this.attach(stream, { resumeMode: true });

		return new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (force: boolean) => {
				if (settled) return;
				settled = true;
				clearInterval(poll);
				clearTimeout(grace);
				resolve(force);
			};
			stream.on("error", async (err) => {
				if (isResumeImpossibleError(err)) {
					logger.error(
						"RESUME:db.watch token global inválido/expirado — re-dump de tudo",
					);
					await stream.close().catch(() => {});
					this.openFresh(pipeline);
					done(true);
				}
			});
			const poll = setInterval(() => {
				if (stream.resumeToken) done(false);
			}, 50);
			const grace = setTimeout(() => done(false), this.opts.resumeProbeMs);
		});
	}

	private openFresh(pipeline: Document[]): void {
		this.attach(
			this.opts.sourceDb.watch(pipeline, { fullDocument: "updateLookup" }),
		);
	}

	private attach(
		stream: ChangeStream,
		{ resumeMode = false }: { resumeMode?: boolean } = {},
	): void {
		this.stream = stream;
		stream.on("change", (change) => {
			this.lastToken = change._id;
			this.route(change);
		});
		stream.on("error", (err) => {
			if (this.closed) return;
			// só o stream ATUAL reabre (um stream substituído não deve ressuscitar).
			if (this.stream !== stream) return;
			// o fallback do 286 no resume é tratado no openStream.
			if (resumeMode && isResumeImpossibleError(err)) return;
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`WATCH:db.watch ${message}. Reabrindo em 5s...`);
			stream.close().catch(() => {});
			setTimeout(() => {
				if (this.closed || this.stream !== stream) return;
				const pipeline = buildDbWatchPipeline(this.opts.collections);
				const next = this.opts.sourceDb.watch(pipeline, {
					fullDocument: "updateLookup",
					...(this.lastToken ? { startAfter: this.lastToken } : {}),
				});
				this.attach(next, { resumeMode });
			}, RESUME_REOPEN_MS);
		});
	}

	/** Roteia o evento pela ns.coll pra collection de destino correspondente. */
	private route(change: ChangeStreamDocument): void {
		const ns = (change as { ns?: { coll?: string } }).ns;
		const coll = ns?.coll;
		if (!coll) return;
		const route = this.routes.get(coll);
		if (!route) return;
		this.applyEvent(change, route.destCol);
	}

	private applyEvent(change: ChangeStreamDocument, destCol: Collection): void {
		switch (change.operationType) {
			case "insert":
				watchInsertEvent(destCol, change.fullDocument);
				break;
			case "update":
				watchUpdateEvent(destCol, change.fullDocument);
				break;
			case "replace":
				watchReplaceEvent(destCol, change.fullDocument);
				break;
			case "delete":
				watchDeleteEvent(
					change.documentKey._id as never,
					destCol,
					this.deletedIds,
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
