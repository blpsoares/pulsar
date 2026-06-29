/** biome-ignore-all assist/source/organizeImports: <explanation> */
import { acceptableEventOperations } from "../core/sync";
import { SyncEngine } from "../core/sync/engine";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import type { SyncOptionsCli } from "../types/cliOptions";
import { syncYmlSchema, type SyncYmlOptions } from "../types/parseYml";
import parseYml from "../utils/parseYml";
import { setLogConfig } from "../utils/logConfig";
import { customLog, logger } from "../utils/customLog";
import { formatLoadReport } from "../utils/loadReport";
import {
	finishProgress,
	initProgress,
	renderClosingPanel,
	startStatusReporter,
	startWatchHeartbeat,
	stopStatusReporter,
	stopWatchHeartbeat,
} from "../utils/progressManager";

export async function syncCollections(
	ymlPath: string,
	cliParams: SyncOptionsCli,
) {
	const options = parseYml<SyncYmlOptions>(ymlPath, syncYmlSchema);

	const ymlLogging = options.command.sync.logging ?? {};

	// A barra de progresso (cli-progress) depende de um TTY para renderizar e,
	// enquanto está ativa, os logs ficam enfileirados até todas as collections
	// terminarem o dump. Sob pm2/nohup/systemd não há TTY, então desativamos a
	// barra e caímos no log linha-a-linha para que a saída apareça nos logs.
	const isTTY = Boolean(process.stdout.isTTY);
	const wantProgress = ymlLogging.progress ?? true;

	setLogConfig({
		verbose: cliParams.verbose ?? ymlLogging.verbose ?? false,
		progress: wantProgress && isTTY,
	});

	if (wantProgress && !isTTY) {
		customLog(
			"warn",
			"Saída sem TTY detectada (pm2/nohup/systemd) — barra de progresso desativada, usando log linha-a-linha.",
		);
	}

	// Precedência dos parâmetros de performance: flag CLI > yml > default.
	const ymlPerf = options.command.sync.performance ?? {};
	const toNum = (v: unknown): number | undefined => {
		if (v === undefined || v === null || v === "") return undefined;
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	// Precedência: flag CLI > env (compose) > yml > default.
	const parallel =
		toNum(cliParams.parallel) ??
		toNum(process.env.PULSAR_PARALLEL) ??
		ymlPerf.parallel ??
		3;
	const batchSize =
		toNum(cliParams.batch) ??
		toNum(process.env.PULSAR_BATCH_SIZE) ??
		ymlPerf.batchSize ??
		500;
	const flushIntervalMs =
		toNum(process.env.PULSAR_FLUSH_INTERVAL_MS) ??
		ymlPerf.flushIntervalMs ??
		1000;
	const full = Boolean(cliParams.full);
	const copyIndexes = Boolean(options.command.sync.copyIndexes ?? false);
	const migrateViews = options.command.sync.migrateViews ?? false;
	const migrateViewsOn = migrateViews === true || Array.isArray(migrateViews);

	customLog(
		"info",
		`Performance: parallel=${parallel} | batchSize=${batchSize} | flushIntervalMs=${flushIntervalMs}${full ? " | --full (re-dump forçado)" : ""}${copyIndexes ? " | copyIndexes=on" : ""}${migrateViewsOn ? ` | migrateViews=${Array.isArray(migrateViews) ? migrateViews.length : "all"}` : ""}`,
	);

	const client = await conn(options.command.sync.source.uri, "source");
	const db = client.db(options.command.sync.source.db);

	const destClient = await conn(
		options.command.sync.destination.uri,
		"destination",
	);
	const destDb = destClient.db(options.command.sync.destination.db);

	// Shutdown gracioso — registrado ANTES do getCollections/dump, pra que um
	// sinal no meio da listagem/conexão também feche os clients. Faz o flush
	// final do resume token (o próximo restart RETOMA em vez de re-dumpar) e
	// GARANTE a saída: se stop()/close() pendurar (ex.: stream travado no loop
	// do evento >16MB), o timer força o exit. SIGKILL/OOM não passam por aqui
	// (kernel não deixa interceptar), mas aí o próprio kernel fecha os sockets
	// do processo morto → o Atlas recebe RST e derruba a escuta de qualquer jeito.
	let engine: SyncEngine | null = null;
	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		customLog(
			"warn",
			`Recebido ${signal} — encerrando e salvando checkpoints...`,
			true,
		);
		// Teto do shutdown: generoso o bastante p/ o flush concluir mesmo com rede
		// degradada na preempção (ACPI dá ~2 min), mas bounded p/ nunca pendurar
		// (ex.: stream travado no loop do evento >16MB). Configurável por env.
		const shutdownMs = Number(process.env.PULSAR_SHUTDOWN_TIMEOUT_MS) || 30000;
		const forced = setTimeout(() => {
			customLog(
				"error",
				`Shutdown excedeu ${shutdownMs}ms — saída forçada.`,
				true,
			);
			process.exit(1);
		}, shutdownMs);
		forced.unref?.();
		try {
			stopStatusReporter();
			stopWatchHeartbeat();
			await engine?.stop();
			await client.close().catch(() => {});
			await destClient.close().catch(() => {});
		} finally {
			clearTimeout(forced);
			process.exit(0);
		}
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));

	try {
		const collections = await getCollections(
			db,
			cliParams,
			ymlPath,
			options.command.sync.collections,
		);

		initProgress(collections.length);

		customLog(
			"info",
			`Abrindo watch em ${collections.length} collection(s) — eventos: ${acceptableEventOperations.join(", ")}...`,
			true,
		);

		engine = new SyncEngine({
			sourceDb: db,
			destDb,
			collections,
			parallel,
			batchSize,
			flushIntervalMs,
			full,
			copyIndexes,
			migrateViews,
		});

		// Sem barra (não-TTY/container): liga o STATUS heartbeat no docker logs.
		// Configurável: STATUS_INTERVAL_MS (default 10s; 0 desliga).
		const barsActive = wantProgress && isTTY;
		const statusIntervalMs = Number(process.env.STATUS_INTERVAL_MS) || 10000;
		if (!barsActive) startStatusReporter(collections.length, statusIntervalMs);

		const startedAt = Date.now();
		const t0 = performance.now();
		await engine.start();
		const finishedAt = Date.now();
		stopStatusReporter();
		finishProgress();

		// Painel de fechamento (1×): estado, por que não dumpou tudo (as que
		// resumiram só aplicam o delta), docs/tempo, e o que acontece agora.
		const total = collections.length;
		const falhas = engine.failedDumps;
		const stopHint = isTTY
			? "parar: Ctrl+C (salva o checkpoint)"
			: "parar: docker stop (salva o checkpoint, não remova)";
		const panel = renderClosingPanel({
			total,
			resumed: engine.resumedCount,
			dumped: engine.dumpsPlanned - falhas.length,
			dumpedNames: engine.dumpedNames,
			failed: falhas,
			docsDumped: engine.docsDumped,
			durationMs: performance.now() - t0,
			stopHint,
			...(copyIndexes
				? {
						indexes: {
							created: engine.indexesCreated,
							skipped: engine.indexesSkipped,
							failed: engine.indexFailures,
						},
					}
				: {}),
			...(migrateViewsOn
				? {
						views: {
							created: engine.viewsCreated,
							updated: engine.viewsUpdated,
							skipped: engine.viewsSkipped,
							failed: engine.viewFailures,
						},
					}
				: {}),
		});
		console.log(`\n${panel}\n`);
		// Linha única e greppável: nº de collections + início/fim (relógio) + total,
		// pra reportar "banco up em X". Vai pro terminal e pro logs/debug.log.
		customLog("info", formatLoadReport(total, startedAt, finishedAt), true);
		logger.info(
			`SYNC PRONTO: ${total - falhas.length}/${total} em dia | ${engine.resumedCount} retomadas | ${engine.dumpsPlanned - falhas.length} dump | ${engine.docsDumped} docs | falhas: ${falhas.join(",") || "0"}${copyIndexes ? ` | índices: +${engine.indexesCreated} (${engine.indexesSkipped} já existiam, ${engine.indexFailures.length} falhas)` : ""}${migrateViewsOn ? ` | views: +${engine.viewsCreated} (${engine.viewsUpdated} atualizadas, ${engine.viewsSkipped} iguais, ${engine.viewFailures.length} falhas)` : ""}`,
		);

		// Em container (não-TTY): nota do "não remova" + heartbeat do watch 24/7.
		if (!barsActive) {
			console.log(
				[
					"# enquanto este container roda, a réplica fica em TEMPO REAL.",
					"# o estado (resume token + fronteiras) vive no Mongo de DESTINO, não no",
					"# container — então `docker stop` e subir de novo RETOMA de onde parou,",
					"# sem perder nada. Por isso NÃO precisa remover/recriar o container; e",
					"# evite `kill -9`/OOM (aí o checkpoint final não é salvo: perde ~5s,",
					"# re-aplicados idempotente no próximo start).",
				].join("\n"),
			);
			const eng = engine;
			const heartbeatMs = Number(process.env.WATCH_HEARTBEAT_MS) || 60000;
			startWatchHeartbeat(heartbeatMs, () => ({
				uptimeMs: performance.now() - t0,
				totals: eng.eventTotals,
				perColl: [...eng.eventCounts.entries()].sort((a, b) => b[1] - a[1]),
			}));
		}
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
