import type { ResumeToken } from "mongodb";

export type SyncStateDoc = {
	dumpCompletedAt?: number;
	resumeToken?: ResumeToken;
	/** Fronteira do cursor de um dump incompleto (menor _id já processado). */
	dumpCursorId?: unknown;
};

/**
 * Decide, no startup de uma collection, se ela deve **retomar** o change stream
 * pelo resume token (pulando o dump) ou refazer o **dump** completo.
 *
 * - `--full` (opts.full) sempre força dump (override do operador).
 * - Só retoma quando o dump anterior CONCLUIU (`dumpCompletedAt`) E há um token
 *   salvo. Sem qualquer um dos dois, refaz o dump — é o caminho seguro.
 */
export function decideStartupAction(
	state: SyncStateDoc,
	opts: { full: boolean },
): "resume" | "dump" {
	if (opts.full) return "dump";
	if (state.dumpCompletedAt && state.resumeToken) return "resume";
	return "dump";
}

/**
 * Identifica o erro de oplog estourado (`ChangeStreamHistoryLost`, code 286):
 * o resume token caiu fora da janela do oplog e não dá mais pra retomar — a
 * collection precisa de um dump completo.
 */
export function isHistoryLostError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: number; codeName?: string };
	return e.code === 286 || e.codeName === "ChangeStreamHistoryLost";
}
