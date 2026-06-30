import { EventEmitter } from "node:events";
import { customLog, logger } from "../../utils/customLog";
import { t } from "../../utils/i18n";
import { watchDeleteEvent } from "./deleteEvent";

export const watcher = new EventEmitter();

watcher.on(
	"finishDump",
	(
		coll: string,
		total: number,
		stats: { skipped: number; updated: number; inserted: number },
	) => {
		customLog(
			"success",
			t("dump.synced", {
				coll,
				total,
				skipped: stats.skipped,
				updated: stats.updated,
				inserted: stats.inserted,
			}),
			true,
		);
		logger.info(
			`finishDump [${coll}] total=${total} skipped=${stats.skipped} updated=${stats.updated} inserted=${stats.inserted}`,
		);
	},
);
watcher.on("errorDump", (err: Error | unknown, coll: string) => {
	// NÃO dar throw aqui: este é um listener de EventEmitter e um throw vira
	// uncaught exception, derrubando o processo inteiro por causa de um erro
	// transitório (ex.: queda de conexão) numa única collection. Apenas logamos
	// e seguimos — o change stream da collection continua ativo.
	const message = err instanceof Error ? err.message : String(err);
	customLog("error", t("dump.collection_failed", { coll, message }), true);
	logger.error(`DUMP:${coll} ${message}`);
});

// delete: ainda tratado via watchDeleteEvent (propagação de deletes do change stream)
watcher.on("delete", watchDeleteEvent);
