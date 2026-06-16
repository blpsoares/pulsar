import { errorHandler } from "../../errors/errorHandler";
import { customLog, logger } from "../../utils/customLog";
import { dumpCollections } from "./dumpEvent";
import { watchDeleteEvent } from "./deleteEvent";
import { watchInsertEvent } from "./insertEvent";
import { watchUpdateEvent } from "./updateEvent";
import { EventEmitter } from "node:events";
import { watchReplaceEvent } from "./replaceEvent";

export const watcher = new EventEmitter();

watcher.on("dump", dumpCollections);

watcher.on(
	"finishDump",
	(coll: string, total: number, stats: { skipped: number; updated: number; inserted: number }) => {
		customLog(
			"success",
			`Collection [ ${coll} ] concluída — ${total} docs | ${stats.skipped} iguais | ${stats.updated} atualizados | ${stats.inserted} inseridos`,
			true,
		);
		logger.info(`finishDump [${coll}] total=${total} skipped=${stats.skipped} updated=${stats.updated} inserted=${stats.inserted}`);
	},
);
watcher.on("errorDump", (err: Error | unknown, coll: string) => {
	throw errorHandler(err, `DUMP:${coll}`);
});

watcher.on("insert", watchInsertEvent);
watcher.on("update", watchUpdateEvent);
watcher.on("delete", watchDeleteEvent);
watcher.on("replace", watchReplaceEvent);
