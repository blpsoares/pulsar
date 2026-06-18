//TODO: unificar os tipos
export type MigrateOptionsCli = {
	parallel?: number;
	maxRetries?: number;
	all?: boolean;
};
export type SyncOptionsCli = {
	all?: boolean;
	parallel?: number;
	batch?: number;
	verbose?: boolean;
	full?: boolean;
};
