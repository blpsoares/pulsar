/**
 * Orquestração do `sync` vive em `engine.ts` (classe `SyncEngine`), que
 * encapsula o restart incremental (resume token + carimbo de dump), os change
 * streams e os checkpoints — sem estado global, podendo ser parada/recriada.
 */
export const acceptableEventOperations = [
	"insert",
	"update",
	"delete",
	"replace",
];
