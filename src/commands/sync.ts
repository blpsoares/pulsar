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
	const parallel = toNum(cliParams.parallel) ?? ymlPerf.parallel ?? 3;
	const batchSize = toNum(cliParams.batch) ?? ymlPerf.batchSize ?? 500;
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

		const engine = new SyncEngine({
			sourceDb: db,
			destDb,
			collections,
			parallel,
			batchSize,
			full,
		});

		// Shutdown gracioso: faz o flush final do resume token de cada collection
		// antes de sair, pra que o próximo restart consiga RETOMAR (e não re-dumpar).
		let stopping = false;
		const shutdown = async (signal: string) => {
			if (stopping) return;
			stopping = true;
			customLog(
				"warn",
				`Recebido ${signal} — encerrando e salvando checkpoints...`,
				true,
			);
			await engine.stop();
			await client.close().catch(() => {});
			await destClient.close().catch(() => {});
			process.exit(0);
		};
		process.once("SIGINT", () => void shutdown("SIGINT"));
		process.once("SIGTERM", () => void shutdown("SIGTERM"));

		await engine.start();
		finishProgress();

		customLog(
			"info",
			`Dump inicial concluído em ${collections.length} collection(s). Watch contínuo seguindo.`,
			true,
		);
		if (!(wantProgress && isTTY)) {
			logAboveBars(
				"Watch contínuo ativo. Ctrl+C para encerrar (checkpoints serão salvos).",
			);
		}
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
