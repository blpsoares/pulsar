// src/core/sync/changeBuffer.ts
export type ChangeOp = "upsert" | "delete";

/**
 * Acumula eventos de change stream como gatilhos `{coll, id, op}` com DEDUPE por
 * (coll, id): a última operação vence (um delete posterior suprime um upsert e
 * vice-versa). `drain()` esvazia e agrupa por collection. Guarda o `id` original
 * (ObjectId/number/string) — a chave de dedupe é `String(id)`.
 */
export class ChangeBuffer {
	private readonly byColl = new Map<
		string,
		Map<string, { id: unknown; op: ChangeOp }>
	>();

	add(coll: string, id: unknown, op: ChangeOp): void {
		let m = this.byColl.get(coll);
		if (!m) {
			m = new Map();
			this.byColl.set(coll, m);
		}
		m.set(String(id), { id, op });
	}

	size(): number {
		let n = 0;
		for (const m of this.byColl.values()) n += m.size;
		return n;
	}

	drain(): Map<string, { upserts: unknown[]; deletes: unknown[] }> {
		const out = new Map<string, { upserts: unknown[]; deletes: unknown[] }>();
		for (const [coll, m] of this.byColl) {
			const upserts: unknown[] = [];
			const deletes: unknown[] = [];
			for (const { id, op } of m.values()) {
				(op === "delete" ? deletes : upserts).push(id);
			}
			out.set(coll, { upserts, deletes });
		}
		this.byColl.clear();
		return out;
	}
}
