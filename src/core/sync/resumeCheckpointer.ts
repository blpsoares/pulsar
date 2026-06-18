import type { Db, ResumeToken } from "mongodb";
import { saveResumeToken } from "./syncState";

const DEFAULT_INTERVAL_MS = 5000;

type GetToken = () => ResumeToken | null | undefined;

/**
 * Persiste periodicamente o resume token de um change stream no `__sync` do
 * destino. Lê o token via callback `getToken` — que aponta pro
 * `changeStream.resumeToken` (PBRT): ele fica válido mesmo numa collection
 * parada (sem eventos), garantindo que o restart consiga retomar.
 *
 * Desenho pensado pra teste: `flush()` é quem escreve, e só se o token mudou
 * desde o último flush e não é null. `start()/stop()` ligam o timer.
 */
export class ResumeTokenCheckpointer {
	private lastPersisted: string | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly destDb: Db,
		private readonly collectionName: string,
		private readonly getToken: GetToken,
		private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
	) {}

	/**
	 * Persiste o token atual se ele existe e mudou desde o último flush.
	 * Retorna `true` se escreveu, `false` caso contrário.
	 */
	async flush(): Promise<boolean> {
		const token = this.getToken();
		if (token === null || token === undefined) return false;
		const serialized = JSON.stringify(token);
		if (serialized === this.lastPersisted) return false;
		this.lastPersisted = serialized;
		await saveResumeToken(this.destDb, this.collectionName, token);
		return true;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.flush().catch(() => {});
		}, this.intervalMs);
		this.timer.unref?.();
	}

	/** Para o timer e faz um flush final pra não perder o último token. */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.flush();
	}
}
