/** biome-ignore-all assist/source/organizeImports: <explanation> */
import { startWatch, dumpOnly, acceptableEventOperations } from "../core/sync";
import { conn } from "../db/conn";
import { errorHandler } from "../errors/errorHandler";
import { getCollections } from "../functions/getCollections";
import type { SyncOptionsCli } from "../types/cliOptions";
import { syncYmlSchema, type SyncYmlOptions } from "../types/parseYml";
import parseYml from "../utils/parseYml";
import { setLogConfig } from "../utils/logConfig";
import { customLog, logger } from "../utils/customLog";
import { initProgress, logAboveBars } from "../utils/progressManager";
import Bottleneck from "bottleneck";

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

	customLog("info", `Performance: parallel=${parallel} | batchSize=${batchSize}`);

	const client = await conn(options.command.sync.source.uri, "source");
	const db = client.db(options.command.sync.source.db);

	const destClient = await conn(
		options.command.sync.destination.uri,
		"destination",
	);

	const destDb = destClient.db(options.command.sync.destination.db);
	const limiter = new Bottleneck({ maxConcurrent: parallel });

	try {
		const collections = await getCollections(
			db,
			cliParams,
			ymlPath,
			options.command.sync.collections,
		);

		initProgress(collections.length);

		// Pipeline por collection (SEM barreira global): cada uma abre seu watch
		// e, assim que o watch dela está ativo, entra na fila de dump. Um freeze
		// lento numa collection grande atrasa só o dump dela — não bloqueia as
		// outras nem a abertura dos demais watches.
		//
		// - watchLimiter (8): abre os watches em paralelo (custo é server-side,
		//   concorrência sobrepõe a latência). Independente do -p.
		// - limiter (-p): estrangula só os dumps (parte pesada: cursor + batch).
		const watchLimiter = new Bottleneck({ maxConcurrent: 8 });
		let opened = 0;

		customLog(
			"info",
			`Abrindo watch em ${collections.length} collection(s) — eventos: ${acceptableEventOperations.join(", ")}...`,
			true,
		);

		const jobs = collections.map(({ name, filter }) =>
			watchLimiter
				.schedule(async () => {
					await startWatch(name, db, destDb, filter);
					opened++;
					const msg = `👁  watch ativo ${opened}/${collections.length} [ ${name} ]`;
					logger.info(msg);
					// Com barras ativas (TTY), despejar 55 linhas dessas embaralha o
					// redraw — então só vai pro terminal quando NÃO há barras (pm2).
					if (!(wantProgress && isTTY)) logAboveBars(msg);
				})
				.then(() => limiter.schedule(() => dumpOnly(name, db, destDb, filter, batchSize))),
		);

		await Promise.all(jobs);

		customLog(
			"info",
			`Dump inicial concluído em ${collections.length} collection(s). Watch contínuo seguindo.`,
			true,
		);
	} catch (error) {
		throw errorHandler(error, "WATCH:COLL");
	}
}
