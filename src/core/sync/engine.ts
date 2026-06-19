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
import { transformFilterForChangeStream } from "../../utils/mongo";
import { watchDeleteEvent } from "./deleteEvent";
import { dumpCollections } from "./dumpEvent";
import { watchInsertEvent } from "./insertEvent";
import { watchReplaceEvent } from "./replaceEvent";
import { decideStartupAction, isHistoryLostError } from "./restartDecision";
import { ResumeTokenCheckpointer } from "./resumeCheckpointer";
import {
	clearDumpCompleted,
	loadSyncState,
	markDumpCompleted,
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

type ColRuntime = {
	name: string;
	filter?: Document;
	srcCol: Collection;
	destCol: Collection;
	pipeline: Document[];
	stream: ChangeStream | null;
	checkpointer: ResumeTokenCheckpointer;
	lastToken: ResumeToken | undefined;
	closed: boolean;
	/** Fronteira pra retomar um dump incompleto (do __sync); undefined = do zero. */
	dumpResumeFromId?: unknown;
	/** Throttle do checkpoint de progresso do dump. */
	lastDumpSaveAt: number;
};

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

function buildPipeline(filter?: Document): Document[] {
	if (!filter) return [];
	return [
		{
			$match: {
				$or: [
					{ operationType: "delete" },
					transformFilterForChangeStream(filter),
				],
			},
		},
	];
}

/**
 * Orquestra o `sync` de um conjunto de collections com restart incremental:
 * cada collection decide entre RETOMAR pelo resume token (pula o dump) ou
 * refazer o DUMP. Instância isolada (sem estado global) — pode ser parada e
 * recriada no mesmo processo (essencial pra testes de restart).
 */
export class SyncEngine {
	private readonly opts: Required<Omit<SyncEngineOptions, "collections">> & {
		collections: EngineCollection[];
	};
	private readonly runtimes: ColRuntime[] = [];
	private readonly deletedIds: string[] = [];

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
	}

	/**
	 * Abre os watches (paralelo) e roda/decide os dumps (estrangulado por
	 * `parallel`), sem barreira global. Resolve quando todas as collections
	 * concluíram a ação inicial (dump feito ou resume decidido). Os change
	 * streams seguem ativos até `stop()`.
	 */
	async start(): Promise<void> {
		const dumpLimiter = new Bottleneck({ maxConcurrent: this.opts.parallel });
		const watchLimiter = new Bottleneck({ maxConcurrent: 8 });

		const jobs = this.opts.collections.map((col) =>
			watchLimiter
				.schedule(() => this.openInitial(col))
				.then((rt) => dumpLimiter.schedule(() => this.finishStartup(rt))),
		);

		await Promise.all(jobs);
	}

	/** Fecha os streams e faz o flush final dos checkpoints. */
	async stop(): Promise<void> {
		for (const rt of this.runtimes) rt.closed = true;
		await Promise.all(
			this.runtimes.map(async (rt) => {
				await rt.checkpointer.stop();
				if (rt.stream) await rt.stream.close().catch(() => {});
			}),
		);
	}

	/** FASE 1 — decide ação, abre o stream (resume ou fresh). */
	private async openInitial(col: EngineCollection): Promise<ColRuntime> {
		const srcCol = this.opts.sourceDb.collection(col.name);
		const destCol = this.opts.destDb.collection(col.name);
		const rt: ColRuntime = {
			name: col.name,
			filter: col.filter,
			srcCol,
			destCol,
			pipeline: buildPipeline(col.filter),
			stream: null,
			lastToken: undefined,
			closed: false,
			lastDumpSaveAt: 0,
			checkpointer: null as unknown as ResumeTokenCheckpointer,
		};
		rt.checkpointer = new ResumeTokenCheckpointer(
			this.opts.destDb,
			col.name,
			() => rt.stream?.resumeToken ?? rt.lastToken ?? null,
			this.opts.checkpointIntervalMs,
		);
		this.runtimes.push(rt);

		const state = await loadSyncState(this.opts.destDb, col.name);
		const action = decideStartupAction(state, { full: this.opts.full });
		// Dump incompleto com fronteira salva → retoma dali (a não ser com --full).
		rt.dumpResumeFromId = this.opts.full ? undefined : state.dumpCursorId;

		if (action === "resume") {
			const outcome = await this.openResume(rt, state.resumeToken);
			rt.checkpointer.start();
			(rt as ColRuntime & { _needsDump?: boolean })._needsDump =
				outcome === "fallback";
			return rt;
		}

		// dump path: freeze antes de abrir (protege o dump), stream fresh
		await freezeCollection(destCol);
		this.openFresh(rt);
		rt.checkpointer.start();
		(rt as ColRuntime & { _needsDump?: boolean })._needsDump = true;
		return rt;
	}

	/** FASE 2 — roda o dump se necessário e carimba a conclusão. */
	private async finishStartup(rt: ColRuntime): Promise<void> {
		const needsDump = (rt as ColRuntime & { _needsDump?: boolean })._needsDump;
		if (needsDump) {
			const ok = await dumpCollections(rt.srcCol, rt.destCol, this.deletedIds, {
				filter: rt.filter,
				batchSize: this.opts.batchSize,
				resumeFromId: rt.dumpResumeFromId,
				onProgress: (lastId) => this.checkpointDumpProgress(rt, lastId),
			});
			// markDumpCompleted carimba a conclusão E limpa a fronteira (dumpCursorId).
			if (ok) await markDumpCompleted(this.opts.destDb, rt.name);
		}
		// Garante um token persistido assim que possível (não só no tick de 5s).
		await this.waitForToken(rt, this.opts.resumeProbeMs);
		await rt.checkpointer.flush().catch(() => {});
	}

	/**
	 * Salva a fronteira do dump no __sync, com throttle (~checkpointIntervalMs),
	 * pra um restart de dump incompleto continuar de onde parou. Fire-and-forget:
	 * não bloqueia o loop do dump.
	 */
	private checkpointDumpProgress(rt: ColRuntime, lastId: unknown): void {
		const now = Date.now();
		if (now - rt.lastDumpSaveAt < this.opts.checkpointIntervalMs) return;
		rt.lastDumpSaveAt = now;
		void saveDumpProgress(this.opts.destDb, rt.name, lastId).catch(() => {});
	}

	/** Abre stream fresh (sem token) e liga os handlers. */
	private openFresh(rt: ColRuntime): void {
		this.attach(
			rt,
			rt.srcCol.watch(rt.pipeline, { fullDocument: "updateLookup" }),
		);
	}

	/**
	 * Abre stream em modo RESUME (startAfter token). Resolve "resumed" se o
	 * stream estabelece sem erro fatal, ou "fallback" se o resume é impossível
	 * (286/token inválido) — nesse caso limpamos o carimbo pra forçar o dump.
	 */
	private async openResume(
		rt: ColRuntime,
		token: ResumeToken | undefined,
	): Promise<"resumed" | "fallback"> {
		const stream = rt.srcCol.watch(rt.pipeline, {
			fullDocument: "updateLookup",
			startAfter: token,
		});
		this.attach(rt, stream, { resumeMode: true });

		return new Promise<"resumed" | "fallback">((resolve) => {
			let settled = false;
			const done = (r: "resumed" | "fallback") => {
				if (settled) return;
				settled = true;
				clearInterval(poll);
				clearTimeout(grace);
				resolve(r);
			};
			stream.on("error", async (err) => {
				if (isResumeImpossibleError(err)) {
					logger.error(
						`RESUME:${rt.name} token inválido/expirado — fallback p/ dump`,
					);
					await clearDumpCompleted(this.opts.destDb, rt.name);
					await stream.close().catch(() => {});
					await freezeCollection(rt.destCol);
					this.openFresh(rt);
					done("fallback");
				}
			});
			const poll = setInterval(() => {
				if (stream.resumeToken) done("resumed");
			}, 50);
			const grace = setTimeout(() => done("resumed"), this.opts.resumeProbeMs);
		});
	}

	private attach(
		rt: ColRuntime,
		stream: ChangeStream,
		{ resumeMode = false }: { resumeMode?: boolean } = {},
	): void {
		rt.stream = stream;
		stream.on("change", (change) => {
			rt.lastToken = change._id;
			this.applyEvent(change, rt.destCol);
		});
		stream.on("error", (err) => {
			if (rt.closed) return;
			// O fallback do resume é tratado no openResume; aqui é reabertura
			// por erro transitório (queda de conexão etc.).
			if (resumeMode && isResumeImpossibleError(err)) return;
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`WATCH:${rt.name} ${message}. Reabrindo em 5s...`);
			stream.close().catch(() => {});
			setTimeout(() => {
				if (rt.closed) return;
				const next = rt.srcCol.watch(rt.pipeline, {
					fullDocument: "updateLookup",
					...(rt.lastToken ? { startAfter: rt.lastToken } : {}),
				});
				this.attach(rt, next, { resumeMode });
			}, RESUME_REOPEN_MS);
		});
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

	private async waitForToken(rt: ColRuntime, timeoutMs: number): Promise<void> {
		const start = performance.now();
		while (!rt.stream?.resumeToken && !rt.lastToken) {
			if (performance.now() - start > timeoutMs) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
}
