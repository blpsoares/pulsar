import Bottleneck from "bottleneck";
import type {
	ChangeStream,
	Collection,
	Db,
	Document,
	ResumeToken,
} from "mongodb";
import { freezeCollection } from "../../functions/freeze";
import { customLog, logger } from "../../utils/customLog";
import { t } from "../../utils/i18n";
import { setSyncPlan } from "../../utils/progressManager";
import { ChangeBuffer, type ChangeOp } from "./changeBuffer";
import { ensureCollectionIndexes } from "./copyIndexes";
import { copyViews } from "./copyViews";
import { buildDbWatchPipeline } from "./dbWatchPipeline";
import { dumpCollections } from "./dumpEvent";
import { decideStartupAction, isHistoryLostError } from "./restartDecision";
import { ResumeTokenCheckpointer } from "./resumeCheckpointer";
import {
	loadDbResumeToken,
	loadSyncState,
	markDumpCompleted,
	saveDbResumeToken,
	saveDumpProgress,
} from "./syncState";
import { writeDocToDest } from "./writeDoc";

const DEFAULT_PARALLEL = 3;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CHECKPOINT_MS = 5000;
const DEFAULT_FLUSH_MS = 1000;
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
	/** Janela máx. (ms) p/ flush por tempo do buffer de mudanças (default 1000). */
	flushIntervalMs?: number;
	/** Janela máx. p/ considerar um resume estabelecido (e p/ aguardar token). */
	resumeProbeMs?: number;
	/** Replicar no destino os índices secundários da origem (default false). */
	copyIndexes?: boolean;
	/** Recriar no destino as views da origem (metadados, fora do sync). `true` =
	 *  todas; array de nomes = só essas; `false`/omitido = nenhuma. */
	copyViews?: boolean | string[];
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
 * matando a saturação de conexões. Cada evento é enfileirado no ChangeBuffer e
 * aplicado em lote (re-busca em lote + writeDocToDest), tornando o watch imune
 * ao limite de 16MB por evento do change stream.
 *
 * Instância isolada (sem estado global) — pode ser parada e recriada no mesmo
 * processo (essencial pros testes de restart).
 */
export class SyncEngine {
	private readonly opts: Required<Omit<SyncEngineOptions, "collections">> & {
		collections: EngineCollection[];
	};
	private readonly routes = new Map<string, Route>();
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
	/** Migração de views (quando copyViews on): agregados p/ o painel final. */
	viewsCreated = 0;
	viewsUpdated = 0;
	viewsSkipped = 0;
	readonly viewFailures: { name: string; reason: string }[] = [];
	/** Contadores de eventos do watch (p/ o heartbeat): por collection e por tipo. */
	readonly eventCounts = new Map<string, number>();
	readonly eventTotals = { insert: 0, update: 0, replace: 0, delete: 0 };
	private readonly lastDumpSaveAt = new Map<string, number>();
	/** Última fronteira de cada dump em andamento (p/ flush final no stop). */
	private readonly lastFrontier = new Map<string, unknown>();
	private stream: ChangeStream | null = null;
	private checkpointer: ResumeTokenCheckpointer | null = null;
	private lastToken: ResumeToken | undefined;
	/** Buffer de gatilhos do watch: acumula (coll, id, op) com dedupe. */
	private readonly buffer = new ChangeBuffer();
	/** Token do evento mais recente já BUFFERIZADO (vira lastFlushedToken após o flush). */
	private pendingToken: ResumeToken | undefined;
	/** Token do último lote já APLICADO — é o que o checkpoint carimba. */
	private lastFlushedToken: ResumeToken | undefined;
	/** Lock: garante 1 flush por vez (pump x timer). */
	private flushing: Promise<void> | null = null;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	/** Sinaliza ao probe do openStream que o resume caiu no 286 (→ re-dump). */
	private resumeLost = false;
	/** _ids deletados pelo watch ENQUANTO o dump inicial roda (proteção race delete-durante-dump). */
	private readonly deletedIds: string[] = [];
	/** true até os dumps iniciais concluírem — enquanto true, flush registra deletes em deletedIds. */
	private dumpsActive = true;

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
			flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_MS,
			resumeProbeMs: options.resumeProbeMs ?? RESUME_PROBE_MS,
			copyIndexes: options.copyIndexes ?? false,
			copyViews: options.copyViews ?? false,
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

		// 2) checkpoint do token global a cada ~5s — carimba o lastFlushedToken
		//    (o que já foi APLICADO), não o último evento do stream.
		this.checkpointer = new ResumeTokenCheckpointer(
			() => this.lastFlushedToken ?? null,
			(t) => saveDbResumeToken(this.opts.destDb, t),
			this.opts.checkpointIntervalMs,
		);
		this.checkpointer.start();
		// timer do flush por tempo (caso parem de chegar eventos com o buffer cheio)
		this.flushTimer = setInterval(
			() => void this.flush(),
			this.opts.flushIntervalMs,
		);
		this.flushTimer.unref?.();

		// 2.5) MIGRAÇÃO DE VIEWS — em paralelo aos dumps. Views são metadados puros
		//      (sem documentos, sem change stream), então NÃO passam pelo sync: este
		//      passo recria a definição (viewOn/pipeline) e roda concorrente, sem
		//      bloquear o dump (o Mongo cria view até sobre collection inexistente).
		const viewsDone = this.runViewMigration();

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
		// Dumps concluídos: para de acumular deletes e libera a memória.
		this.dumpsActive = false;
		this.deletedIds.length = 0;

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

		// garante que a migração de views (paralela) terminou antes do painel.
		await viewsDone;

		// 5) garante o token global persistido (não só no tick de 5s).
		await this.waitForToken(this.opts.resumeProbeMs);
		// Flush de eventos que chegaram durante o dump (buffer pode ter acumulado).
		await this.flush().catch(() => {});
		// Se nenhum evento foi processado (dump puro sem mudanças online), semeia
		// o lastFlushedToken com a posição atual do stream — o dump cobre tudo até
		// aqui, então é seguro fazer o checkpoint nesse ponto.
		// Guarda (C1): só semeia se o buffer está vazio; se o flush falhou e
		// re-enfileirou ids, não avançamos o token — o restart re-entrega esses ids.
		if (!this.lastFlushedToken && this.buffer.size() === 0) {
			this.lastFlushedToken =
				(this.stream?.resumeToken as ResumeToken | undefined) ?? this.lastToken;
		}
		await this.checkpointer.flush().catch(() => {});
	}

	/** Fecha o stream e faz o flush final do checkpoint. */
	async stop(): Promise<void> {
		this.closed = true;
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush().catch(() => {});
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

	/**
	 * Recria as views da origem no destino (em paralelo, fora do sync). Contido:
	 * uma falha de view não derruba o sync (entra em `viewFailures`, re-tentada no
	 * próximo startup). `listCollections` da origem falhando também é contido.
	 */
	private async runViewMigration(): Promise<void> {
		const mv = this.opts.copyViews;
		if (mv === false) return;
		const names = Array.isArray(mv) ? mv : undefined;
		if (names && names.length === 0) return;
		try {
			const res = await copyViews(this.opts.sourceDb, this.opts.destDb, names);
			this.viewsCreated = res.created;
			this.viewsUpdated = res.updated;
			this.viewsSkipped = res.skipped;
			this.viewFailures.push(...res.failed);
			const parts = [
				t("views.part_created", { created: res.created }),
				t("views.part_updated", { updated: res.updated }),
				t("views.part_skipped", { skipped: res.skipped }),
			];
			if (res.failed.length > 0) {
				parts.push(t("views.part_failed", { failed: res.failed.length }));
			}
			customLog("info", t("views.summary", { parts: parts.join(", ") }));
			for (const f of res.failed) {
				customLog(
					"warn",
					t("views.failure", { name: f.name, reason: f.reason }),
				);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			customLog("warn", t("views.list_migrate_failed", { reason }));
		}
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
			customLog("warn", t("indexes.copy_failed", { coll: col.name, reason }));
			return;
		}
		this.indexesCreated += res.created;
		this.indexesSkipped += res.skipped;
		for (const f of res.failed)
			this.indexFailures.push({ coll: col.name, name: f.name });
		const parts = [
			t("indexes.part_created", { created: res.created }),
			t("indexes.part_existed", { skipped: res.skipped }),
		];
		if (res.failed.length > 0) {
			parts.push(
				t("indexes.part_failed", {
					failed: res.failed.length,
					names: res.failed.map((f) => f.name).join(", "),
				}),
			);
		}
		customLog(
			"info",
			t("indexes.summary", { coll: col.name, parts: parts.join(", ") }),
		);
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
			this.runStream(this.opts.sourceDb.watch(pipeline), false);
			return false;
		}
		this.resumeLost = false;
		const stream = this.opts.sourceDb.watch(pipeline, {
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
	 * change stream enquanto o enfileiramento + flush por tamanho não terminam.
	 * Eventos são acumulados no ChangeBuffer e aplicados em lote (re-busca $in),
	 * tornando o watch imune ao limite de 16MB por evento (o evento em si é só um
	 * gatilho; o documento real é buscado com findOne/$in numa query separada).
	 * Numa falha transitória reabre com `startAfter: lastToken` em 5s; no 286 do
	 * resume, sinaliza resumeLost e reabre fresh.
	 */
	private async pump(stream: ChangeStream, resumeMode: boolean): Promise<void> {
		try {
			for await (const change of stream) {
				if (this.closed || this.stream !== stream) break;
				this.lastToken = change._id;
				const coll = (change as { ns?: { coll?: string } }).ns?.coll;
				if (!coll || !this.routes.has(coll)) continue;
				const op: ChangeOp =
					change.operationType === "delete" ? "delete" : "upsert";
				const id = (change as { documentKey?: { _id?: unknown } }).documentKey
					?._id;
				if (id === undefined) continue;
				this.buffer.add(coll, id, op);
				this.pendingToken = change._id;
				this.countEvent(coll, change.operationType as never);
				if (this.buffer.size() >= this.opts.batchSize) await this.flush();
			}
		} catch (err) {
			if (this.closed || this.stream !== stream) return;
			const pipeline = buildDbWatchPipeline(this.opts.collections);
			if (resumeMode && isResumeImpossibleError(err)) {
				logger.error(t("resume.token_invalid"));
				this.resumeLost = true;
				// M1: descarta o buffer obsoleto do stream expirado (token não mais
				// válido); o re-dump vai reconciliar tudo — não pode aplicar eventos
				// de um stream morto com um pendingToken que nunca será persistido.
				this.buffer.drain();
				this.pendingToken = undefined;
				await stream.close().catch(() => {});
				this.runStream(this.opts.sourceDb.watch(pipeline), false);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.error(t("watch.reopening", { message }));
			await stream.close().catch(() => {});
			setTimeout(() => {
				if (this.closed || this.stream !== stream) return;
				const next = this.opts.sourceDb.watch(pipeline, {
					...(this.lastToken ? { startAfter: this.lastToken } : {}),
				});
				this.runStream(next, resumeMode);
			}, RESUME_REOPEN_MS);
		}
	}

	/** Aplica o buffer: re-busca em lote por collection, grava/deleta no destino,
	 *  e carimba o token aplicado. 1 flush por vez (lock). Best-effort por-coll. */
	private async flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		if (this.buffer.size() === 0) return;
		const tokenAtDrain = this.pendingToken;
		const grouped = this.buffer.drain();
		this.flushing = (async () => {
			let allOk = true;
			for (const [coll, { upserts, deletes }] of grouped) {
				const route = this.routes.get(coll);
				if (!route) continue;
				try {
					if (deletes.length > 0) {
						await route.destCol.deleteMany({ _id: { $in: deletes } });
						// Informa o dump concorrente (I1): docs já deletados não devem ser
						// ressuscitados caso o cursor do dump ainda não os tenha processado.
						if (this.dumpsActive)
							for (const id of deletes) this.deletedIds.push(String(id));
					}
					if (upserts.length > 0) {
						const query = route.filter
							? { $and: [{ _id: { $in: upserts } }, route.filter] }
							: { _id: { $in: upserts } };
						const docs = await route.srcCol.find(query).toArray();
						const found = new Set(docs.map((d) => String(d._id)));
						// ausentes na re-busca = deletados OU saíram do filtro → delete no destino
						const missing = upserts.filter((id) => !found.has(String(id)));
						if (missing.length > 0) {
							await route.destCol.deleteMany({ _id: { $in: missing } });
							// Também registra os "missing" como deletados pro dump concorrente.
							if (this.dumpsActive)
								for (const id of missing) this.deletedIds.push(String(id));
						}
						for (const doc of docs) {
							await writeDocToDest(route.destCol, doc, "watch:refetch");
						}
					}
				} catch (err) {
					allOk = false;
					const msg = err instanceof Error ? err.message : String(err);
					logger.error(`FLUSH:${coll} ${msg}`);
					// re-enfileira os ids da collection que falhou para retry no próximo flush
					for (const id of deletes) this.buffer.add(coll, id, "delete");
					for (const id of upserts) this.buffer.add(coll, id, "upsert");
				}
			}
			// só avança o checkpoint se TODO o lote foi aplicado com sucesso —
			// uma falha parcial mantém o token parado e re-entrega no próximo flush.
			if (allOk && tokenAtDrain) this.lastFlushedToken = tokenAtDrain;
		})();
		try {
			await this.flushing;
		} finally {
			this.flushing = null;
		}
	}

	/** Conta o evento (por collection + por tipo) p/ o heartbeat do watch. */
	private countEvent(
		coll: string,
		op: "insert" | "update" | "replace" | "delete",
	): void {
		this.eventTotals[op]++;
		this.eventCounts.set(coll, (this.eventCounts.get(coll) ?? 0) + 1);
	}

	private async waitForToken(timeoutMs: number): Promise<void> {
		const start = performance.now();
		while (!this.stream?.resumeToken && !this.lastToken) {
			if (performance.now() - start > timeoutMs) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
}
