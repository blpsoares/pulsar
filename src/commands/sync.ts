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
import { customLog } from "../utils/customLog";
import {
	finishProgress,
	initProgress,
	startStatusReporter,
	stopStatusReporter,
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
	const full = Boolean(cliParams.full);

	customLog(
		"info",
		`Performance: parallel=${parallel} | batchSize=${batchSize}${full ? " | --full (re-dump forçado)" : ""}`,
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
			full,
		});

		// Sem barra (não-TTY/container): liga o STATUS heartbeat no docker logs.
		// Configurável: STATUS_INTERVAL_MS (default 10s; 0 desliga).
		const barsActive = wantProgress && isTTY;
		const statusIntervalMs = Number(process.env.STATUS_INTERVAL_MS) || 10000;
		if (!barsActive) startStatusReporter(collections.length, statusIntervalMs);

		await engine.start();
		stopStatusReporter();
		finishProgress();

		// Relatório final OBJETIVO: estado (quantas em dia), por que não dumpou tudo
		// (as que resumiram já tinham cópia → só o delta via change stream), e o que
		// está acontecendo agora (tempo real). Ctrl+C só no terminal; em container a
		// forma de parar é SIGTERM (docker stop).
		const total = collections.length;
		const falhas = engine.failedDumps;
		const dumpOk = engine.dumpsPlanned - falhas.length;
		const emDia = total - falhas.length;
		const comoParar = isTTY
			? "Ctrl+C encerra (salva o checkpoint)."
			: "Encerrar (só se precisar): `docker stop` — salva o checkpoint antes de sair. NÃO remova o container.";

		const linha1 =
			falhas.length > 0
				? `SYNC PRONTO: ${emDia}/${total} collections em dia · ${falhas.length} FALHARAM e re-dumpam no próximo restart → ${falhas.join(", ")}`
				: `SYNC PRONTO: ${total}/${total} collections em dia.`;

		customLog(
			falhas.length > 0 ? "warn" : "info",
			[
				linha1,
				`  • ${engine.resumedCount} retomadas SEM dump: já estavam copiadas de antes → aplicamos só o que mudou enquanto o pulsar esteve off (via change stream), em vez de recopiar tudo.`,
				`  • ${dumpOk} copiadas com dump completo nesta execução.`,
				`  AGORA: tempo real — cada insert/update/delete na origem cai no destino na hora. Deixe rodando 24/7.`,
				`  ${comoParar}`,
			].join("\n"),
			true,
		);
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
