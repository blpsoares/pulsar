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
	logAboveBars,
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

		const falharam = engine.failedDumps;
		if (falharam.length > 0) {
			customLog(
				"warn",
				`Dump inicial: ${falharam.length} collection(s) FALHARAM mesmo após retries e serão RETOMADAS da fronteira no próximo restart: ${falharam.join(", ")}. As demais estão OK (concluídas ou retomadas). Watch contínuo seguindo.`,
				true,
			);
		} else {
			customLog(
				"info",
				`Dump inicial concluído em ${collections.length} collection(s). Watch contínuo seguindo.`,
				true,
			);
		}
		// Mensagem do estado contínuo, adequada ao contexto: num terminal o Ctrl+C
		// faz sentido; num container/daemon (não-TTY) Ctrl+C confunde (induz a parar
		// o container) — lá a forma certa de encerrar é SIGTERM (docker stop /
		// systemctl stop), que dispara o shutdown gracioso. NÃO é pra parar nada:
		// é o regime normal de operação 24/7.
		if (isTTY) {
			logAboveBars(
				"Watch contínuo ativo — sincronizando em tempo real. Ctrl+C encerra (checkpoints são salvos).",
			);
		} else {
			customLog(
				"info",
				"Watch contínuo ativo — sincronizando em tempo real (regime normal 24/7, sem novo dump). Deixe rodando. Para encerrar com segurança: docker stop / systemctl stop (SIGTERM) — o checkpoint é salvo no shutdown gracioso.",
				true,
			);
		}
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
