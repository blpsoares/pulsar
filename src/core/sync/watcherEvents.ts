import { errorHandler } from "../../errors/errorHandler";
import { customLog } from "../../utils/customLog";
import { dumpCollections } from "./dumpEvent";
import { watchDeleteEvent } from "./deleteEvent";
import { watchInsertEvent } from "./insertEvent";
import { watchUpdateEvent } from "./updateEvent";
import { EventEmitter } from "node:events";

export const watcher = new EventEmitter();

watcher.on("dump", dumpCollections);

watcher.on("finishDump", (coll: string) =>
	customLog("success", `Collection [ ${coll} ] migrada para o destino.`, true),
);
watcher.on("errorDump", (err: Error | unknown, coll: string) => {
	throw errorHandler(err, `DUMP:${coll}`);
});

watcher.on("insert", watchInsertEvent);
watcher.on("update", watchUpdateEvent);
watcher.on("delete", watchDeleteEvent);
