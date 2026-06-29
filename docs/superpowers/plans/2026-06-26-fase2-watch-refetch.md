# Fase 2 — watch como gatilho + re-busca em lote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O `db.watch` deixa de carregar o documento no evento (sem `updateLookup`, com `$project` tirando `fullDocument`/`updateDescription`); o evento vira só `_id`+operação (nunca >16MB), e o dado vem de um `find($in)` em lote na origem, escrito via `writeDocToDest` (Fase 1). Imune ao crash de 16MB e réplica idêntica.

**Architecture:** Um `ChangeBuffer` (puro) acumula eventos `{coll,id,op}` com dedupe; o `pump` do engine alimenta o buffer e dispara `flush` por tamanho ou por tempo. O `flush` re-busca os docs (`find` com o filtro da collection embutido), grava via `writeDocToDest`, deleta o que sumiu/saiu do filtro, e só então carimba o `lastFlushedToken`. Construído EM CIMA da Fase 1 (branch `feat/writedoc-migratedat`).

**Tech Stack:** Bun, TypeScript, mongodb v6, bottleneck, Biome. Testes: `bun test` contra Mongo real (`bun run test:up`).

## Global Constraints

- `db.watch` aberto **SEM `fullDocument: "updateLookup"`** em TODOS os pontos (não basta `$project` — com updateLookup o servidor monta o evento gigante antes do project e estoura).
- `$project: { fullDocument: 0, updateDescription: 0 }` como ÚLTIMO stage → evento sempre só metadado.
- Filtro por collection sai do `$match` e é aplicado **na query de re-busca** (`find({ $and: [{_id:{$in}}, filter] })`), não client-side.
- Re-busca → escreve via `writeDocToDest` (Fase 1: replace + `__migratedAt` imutável).
- Doc que o `find` não retorna (deletado/saiu do filtro) → `delete` no destino.
- Checkpoint carimba o `lastFlushedToken` (token do último evento de um lote JÁ aplicado), NUNCA o `stream.resumeToken` (que lê adiante).
- Flush por `batchSize` (reusa o existente) OU `flushIntervalMs` (novo, default 1000ms), o que vier primeiro. Guard contra flush concorrente.
- Best-effort por-doc (uma escrita que falha loga, não derruba o lote).
- Substitui o `updateLookup` (sem flag de legado). Mantém: detecção de 286 (`isResumeImpossibleError`), reabertura em falha transitória, race do dump via `__sync.hot`.
- Nomes genéricos nos testes. Mongo real via `SRC_URI`/`DST_URI` + `test/helpers.ts`.

---

### Task 1: `ChangeBuffer` (lógica pura)

**Files:**
- Create: `src/core/sync/changeBuffer.ts`
- Test: `test/changeBuffer.test.ts`

**Interfaces:**
- Produces:
  - `type ChangeOp = "upsert" | "delete"`
  - `class ChangeBuffer` com:
    - `add(coll: string, id: unknown, op: ChangeOp): void` — dedupe por (coll, id-string); a última op vence.
    - `size(): number` — nº de (coll,id) distintos pendentes.
    - `drain(): Map<string, { upserts: unknown[]; deletes: unknown[] }>` — esvazia e devolve agrupado por collection; `size()` volta a 0.

- [ ] **Step 1: Write the failing test**

```ts
// test/changeBuffer.test.ts
import { describe, expect, test } from "bun:test";
import { ChangeBuffer } from "../src/core/sync/changeBuffer";

describe("ChangeBuffer", () => {
  test("agrupa upserts e deletes por collection", () => {
    const b = new ChangeBuffer();
    b.add("a", 1, "upsert");
    b.add("a", 2, "delete");
    b.add("b", 3, "upsert");
    expect(b.size()).toBe(3);
    const out = b.drain();
    expect(out.get("a")?.upserts).toEqual([1]);
    expect(out.get("a")?.deletes).toEqual([2]);
    expect(out.get("b")?.upserts).toEqual([3]);
    expect(b.size()).toBe(0);
  });

  test("dedupe: última op vence (upsert depois delete = delete)", () => {
    const b = new ChangeBuffer();
    b.add("a", 1, "upsert");
    b.add("a", 1, "delete");
    expect(b.size()).toBe(1);
    const out = b.drain();
    expect(out.get("a")?.deletes).toEqual([1]);
    expect(out.get("a")?.upserts).toEqual([]);
  });

  test("dedupe: delete depois upsert = upsert", () => {
    const b = new ChangeBuffer();
    b.add("a", 1, "delete");
    b.add("a", 1, "upsert");
    expect(b.size()).toBe(1);
    expect(b.drain().get("a")?.upserts).toEqual([1]);
  });

  test("drain vazio devolve mapa vazio", () => {
    const b = new ChangeBuffer();
    expect(b.drain().size).toBe(0);
    expect(b.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/changeBuffer.test.ts`
Expected: FAIL ("Cannot find module '../src/core/sync/changeBuffer'").

- [ ] **Step 3: Write the implementation**

```ts
// src/core/sync/changeBuffer.ts
export type ChangeOp = "upsert" | "delete";

/**
 * Acumula eventos de change stream como gatilhos `{coll, id, op}` com DEDUPE por
 * (coll, id): a última operação vence (um delete posterior suprime um upsert e
 * vice-versa). `drain()` esvazia e agrupa por collection. Guarda o `id` original
 * (ObjectId/number/string) — a chave de dedupe é `String(id)`.
 */
export class ChangeBuffer {
  private readonly byColl = new Map<string, Map<string, { id: unknown; op: ChangeOp }>>();

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/changeBuffer.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/changeBuffer.ts test/changeBuffer.test.ts
git add src/core/sync/changeBuffer.ts test/changeBuffer.test.ts
git commit -m "feat: ChangeBuffer (dedupe de eventos como gatilho, agrupado por collection)"
```

---

### Task 2: pipeline do watch sem dado (sem updateLookup, com `$project`)

**Files:**
- Modify: `src/core/sync/dbWatchPipeline.ts`
- Test: `test/dbWatchPipeline.test.ts` (estender o existente)

**Interfaces:**
- Produces: `buildDbWatchPipeline(collections)` agora devolve `[{ $match: { $or: [{ "ns.coll": name }...] } }, { $project: { fullDocument: 0, updateDescription: 0 } }]` — SEM cláusulas de filtro no `$match` (o filtro vai pra re-busca na Fase 2). Delete e demais ops passam por `ns.coll`.

- [ ] **Step 1: Write the failing test**

Adicionar ao `test/dbWatchPipeline.test.ts` (dentro do `describe` existente):

```ts
  test("não usa filtro no $match e projeta fora fullDocument/updateDescription", () => {
    const p = buildDbWatchPipeline([
      { name: "a" },
      { name: "b", filter: { status: "active" } },
    ]);
    // último stage = $project removendo os campos grandes
    const project = p[p.length - 1];
    expect(project).toEqual({ $project: { fullDocument: 0, updateDescription: 0 } });
    // $match casa só por ns.coll (uma cláusula por collection), sem filtro
    const match = p[0] as { $match: { $or: Array<Record<string, unknown>> } };
    expect(match.$match.$or).toEqual([{ "ns.coll": "a" }, { "ns.coll": "b" }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dbWatchPipeline.test.ts`
Expected: FAIL (hoje há cláusulas de filtro/`fullDocument.` no $match e não há `$project`).

- [ ] **Step 3: Reescrever `buildDbWatchPipeline`**

Substituir o corpo de `src/core/sync/dbWatchPipeline.ts` por:

```ts
import type { Document } from "mongodb";

export type WatchedCollection = { name: string; filter?: Document };

/**
 * Pipeline do change stream único (`db.watch`) na Fase 2: o evento é só GATILHO.
 * - `$match` recorta nas X collections por `ns.coll` (qualquer operação). O
 *   filtro por collection NÃO entra aqui — ele é aplicado na re-busca (o engine
 *   faz `find({ $and: [{_id:{$in}}, filter] })`), então um update que tira o doc
 *   do filtro também é detectado (vira delete no destino).
 * - `$project` REMOVE `fullDocument` e `updateDescription` → o evento nunca
 *   carrega o documento, logo nunca passa de 16MB. O stream é aberto SEM
 *   `updateLookup` (no engine), então `fullDocument` nem é montado.
 */
export function buildDbWatchPipeline(
  collections: WatchedCollection[],
): Document[] {
  const clauses: Document[] = collections.map(({ name }) => ({ "ns.coll": name }));
  if (clauses.length === 0) return [];
  return [
    { $match: { $or: clauses } },
    { $project: { fullDocument: 0, updateDescription: 0 } },
  ];
}
```

(`transformFilterForChangeStream` deixa de ser usado aqui; manter o export em `utils/mongo.ts` — outros testes podem referenciá-lo, não remover nesta task.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dbWatchPipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/dbWatchPipeline.ts test/dbWatchPipeline.test.ts
git add src/core/sync/dbWatchPipeline.ts test/dbWatchPipeline.test.ts
git commit -m "feat: pipeline do watch só-gatilho (sem filtro no match, projeta fora o doc)"
```

---

### Task 3: engine — re-busca em lote + checkpoint por flush

**Files:**
- Modify: `src/core/sync/engine.ts`
- Test: `test/engine.refetch.test.ts`

**Interfaces:**
- Consumes: `ChangeBuffer`/`ChangeOp` (Task 1), `buildDbWatchPipeline` (Task 2), `writeDocToDest` (Fase 1).
- Produces: opção `flushIntervalMs?: number` em `SyncEngineOptions` (default 1000). O engine passa a aplicar mudanças por re-busca em lote.

- [ ] **Step 1: Write the failing test**

```ts
// test/engine.refetch.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { SyncEngine } from "../src/core/sync/engine";
import { setLogConfig } from "../src/utils/logConfig";
import { connect, DST_URI, dropDb, seed, SRC_URI, sleep, uniqueDbName, waitFor } from "./helpers";

let srcClient: MongoClient;
let dstClient: MongoClient;
let srcDb: Db;
let dstDb: Db;
let srcName: string;
let dstName: string;

beforeAll(async () => {
  setLogConfig({ verbose: false, progress: false });
  srcClient = await connect(SRC_URI);
  dstClient = await connect(DST_URI);
  srcName = uniqueDbName("refetch_src");
  dstName = uniqueDbName("refetch_dst");
  srcDb = srcClient.db(srcName);
  dstDb = dstClient.db(dstName);
});

afterAll(async () => {
  await dropDb(srcClient, srcName);
  await dropDb(dstClient, dstName);
  await srcClient.close();
  await dstClient.close();
});

beforeEach(async () => {
  await srcDb.dropDatabase();
  await dstDb.dropDatabase();
});

function mkEngine() {
  return new SyncEngine({
    sourceDb: srcDb,
    destDb: dstDb,
    collections: [{ name: "c" }],
    checkpointIntervalMs: 100,
    flushIntervalMs: 150,
  });
}

describe("SyncEngine — watch por re-busca", () => {
  test("insert/update ao vivo são replicados (via re-busca), com __migratedAt", async () => {
    await seed(srcDb, "c", 1); // _id:0
    const engine = mkEngine();
    await engine.start();

    await srcDb.collection("c").insertOne({ _id: 5 as any, v: "novo" });
    await srcDb.collection("c").updateOne({ _id: 0 as any }, { $set: { v: "alterado" } });

    const ok = await waitFor(async () => {
      const a = await dstDb.collection("c").findOne({ _id: 5 as any });
      const b = await dstDb.collection("c").findOne({ _id: 0 as any });
      return a?.v === "novo" && b?.v === "alterado";
    }, 8000);
    expect(ok).toBe(true);
    const novo = await dstDb.collection("c").findOne({ _id: 5 as any });
    expect(novo?.__migratedAt).toBeInstanceOf(Date);

    await engine.stop();
  });

  test("delete ao vivo propaga", async () => {
    await seed(srcDb, "c", 2); // _id 0,1
    const engine = mkEngine();
    await engine.start();
    await waitFor(async () => (await dstDb.collection("c").countDocuments()) === 2, 8000);

    await srcDb.collection("c").deleteOne({ _id: 1 as any });
    const gone = await waitFor(
      async () => (await dstDb.collection("c").findOne({ _id: 1 as any })) === null,
      8000,
    );
    expect(gone).toBe(true);
    await engine.stop();
  });

  test("documento grande NÃO quebra o stream (sem erro 16MB) e chega no destino", async () => {
    await seed(srcDb, "c", 1);
    const engine = mkEngine();
    await engine.start();

    // ~12MB de string num doc; um update grande NÃO pode derrubar o watch
    const big = "x".repeat(12 * 1024 * 1024);
    await srcDb.collection("c").insertOne({ _id: 9 as any, big });

    const arrived = await waitFor(async () => {
      const d = await dstDb.collection("c").findOne({ _id: 9 as any }, { projection: { _id: 1 } });
      return d !== null;
    }, 15000);
    expect(arrived).toBe(true);
    await engine.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine.refetch.test.ts`
Expected: FAIL (`flushIntervalMs` não existe / docs não chegam via re-busca).

- [ ] **Step 3: Implementar no `engine.ts`**

(a) Imports (junto dos existentes):

```ts
import { ChangeBuffer, type ChangeOp } from "./changeBuffer";
import { writeDocToDest } from "./writeDoc";
```

(b) `SyncEngineOptions` — adicionar:

```ts
  /** Janela máx. (ms) p/ flush por tempo do buffer de mudanças (default 1000). */
  flushIntervalMs?: number;
```

(c) No construtor `this.opts`, somar (junto dos outros defaults):

```ts
      flushIntervalMs: options.flushIntervalMs ?? 1000,
```

(d) Campos novos na classe (perto de `lastToken`):

```ts
  private readonly buffer = new ChangeBuffer();
  /** Token do evento mais recente já BUFFERIZADO (vira lastFlushedToken após o flush). */
  private pendingToken: ResumeToken | undefined;
  /** Token do último lote já APLICADO — é o que o checkpoint carimba. */
  private lastFlushedToken: ResumeToken | undefined;
  /** Lock: garante 1 flush por vez (pump x timer). */
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
```

(e) Trocar o `getToken` do checkpointer (no `start()`) p/ usar o token aplicado:

```ts
    this.checkpointer = new ResumeTokenCheckpointer(
      () => this.lastFlushedToken ?? null,
      (t) => saveDbResumeToken(this.opts.destDb, t),
      this.opts.checkpointIntervalMs,
    );
    this.checkpointer.start();
    // timer do flush por tempo (caso parem de chegar eventos com o buffer cheio)
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    this.flushTimer.unref?.();
```

(f) Abrir TODOS os `sourceDb.watch(...)` SEM `updateLookup`. São 4 pontos — remover `fullDocument: "updateLookup"`:
- `openStream` ramo sem token: `this.opts.sourceDb.watch(pipeline)`
- `openStream` ramo com token: `this.opts.sourceDb.watch(pipeline, { startAfter: globalToken })`
- `pump` reabertura no 286: `this.opts.sourceDb.watch(pipeline)`
- `pump` reabertura transitória: `this.opts.sourceDb.watch(pipeline, { ...(this.lastToken ? { startAfter: this.lastToken } : {}) })`

(g) `pump` — trocar o corpo do `for await` (a parte do `try`) por enfileirar no buffer e flush por tamanho:

```ts
      for await (const change of stream) {
        if (this.closed || this.stream !== stream) break;
        this.lastToken = change._id;
        const coll = (change as { ns?: { coll?: string } }).ns?.coll;
        if (!coll || !this.routes.has(coll)) continue;
        const op: ChangeOp =
          change.operationType === "delete" ? "delete" : "upsert";
        const id = (change as { documentKey?: { _id?: unknown } }).documentKey?._id;
        if (id === undefined) continue;
        this.buffer.add(coll, id, op);
        this.pendingToken = change._id;
        this.countEvent(coll, change.operationType as never);
        if (this.buffer.size() >= this.opts.batchSize) await this.flush();
      }
```

(h) Novo método `flush` (perto de `route`). Re-busca com filtro embutido, escreve via `writeDocToDest`, deleta o ausente; carimba `lastFlushedToken` só no fim:

```ts
  /** Aplica o buffer: re-busca em lote por collection, grava/deleta no destino,
   *  e carimba o token aplicado. 1 flush por vez (lock). Best-effort por-doc. */
  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.size() === 0) return;
    const tokenAtDrain = this.pendingToken;
    const grouped = this.buffer.drain();
    this.flushing = (async () => {
      for (const [coll, { upserts, deletes }] of grouped) {
        const route = this.routes.get(coll);
        if (!route) continue;
        try {
          if (deletes.length > 0) {
            await route.destCol.deleteMany({ _id: { $in: deletes } });
          }
          if (upserts.length > 0) {
            const query = route.filter
              ? { $and: [{ _id: { $in: upserts } }, route.filter] }
              : { _id: { $in: upserts } };
            const docs = await route.srcCol.find(query).toArray();
            const found = new Set(docs.map((d) => String(d._id)));
            // ausentes na re-busca = deletados OU saíram do filtro → delete no destino
            const missing = upserts.filter((id) => !found.has(String(id)));
            if (missing.length > 0) {
              await route.destCol.deleteMany({ _id: { $in: missing } });
            }
            for (const doc of docs) {
              await writeDocToDest(route.destCol, doc, "watch:refetch");
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`FLUSH:${coll} ${msg}`);
        }
      }
      // só agora o lote está aplicado: o checkpoint pode avançar.
      if (tokenAtDrain) this.lastFlushedToken = tokenAtDrain;
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }
```

(i) `applyEvent`/`route` antigos: o `route` não é mais chamado pelo pump (o pump enfileira direto). Manter `countEvent` (usado em (g)). Remover o método `applyEvent` e o `route` antigos (e o `deletedIds`/`dumpsActive` ligados ao watch — o delete agora passa pelo flush). NÃO remover `countEvent`, `eventCounts`, `eventTotals`.

(j) `stop()` — antes de fechar o stream, parar o timer e fazer um flush final + flush do checkpoint:

```ts
  async stop(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush().catch(() => {});
    if (this.checkpointer) await this.checkpointer.stop();
    await Promise.all(
      [...this.lastFrontier.entries()].map(([name, id]) =>
        saveDumpProgress(this.opts.destDb, name, id).catch(() => {}),
      ),
    );
    if (this.stream) await this.stream.close().catch(() => {});
  }
```

(k) No `start()`, o `waitForToken`/`checkpointer.flush()` final (passo 5 do start) seguem; o `effectiveToken` e a lógica de dump não mudam. O `deletedIds` que `runDump` passa pra `dumpCollections` pode virar uma lista vazia fixa (o watch não popula mais `deletedIds`); manter a assinatura de `dumpCollections` passando `[]`.

- [ ] **Step 4: Run new test + engine regression**

Run: `bun test test/engine.refetch.test.ts`
Expected: PASS (3 testes; o de doc grande prova a imunidade ao 16MB).

Run: `bun test test/engine.dbwatch.test.ts test/engine.dump.test.ts test/engine.restart.test.ts test/engine.fallback.test.ts test/engine.race.test.ts test/engine.full.test.ts test/dbResumeToken.test.ts`
Expected: PASS. (Se `engine.race` ou `engine.restart` falharem por causa da mudança do delete/checkpoint, reportar BLOCKED com o output — a semântica de race/checkpoint mudou e pode exigir ajuste do teste, decisão do controlador.)

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/engine.ts test/engine.refetch.test.ts
git add src/core/sync/engine.ts test/engine.refetch.test.ts
git commit -m "feat: engine aplica watch por re-busca em lote (imune a 16MB) + checkpoint por flush"
```

---

### Task 4: limpeza dos handlers mortos + config + docs

**Files:**
- Delete: `src/core/sync/insertEvent.ts`, `src/core/sync/updateEvent.ts`, `src/core/sync/replaceEvent.ts`, `src/core/sync/applyEvent`-relacionados se houver, `test/writeDocWatch.test.ts`
- Modify: `src/commands/sync.ts` (passar `flushIntervalMs`), `src/core/sync/index.ts` (se exporta os handlers), `CLAUDE.md`

**Interfaces:**
- Consumes: nada novo.
- Produces: `flushIntervalMs` lido do env/yml e passado ao `SyncEngine`.

- [ ] **Step 1: Remover os handlers agora mortos**

O `flush` (Task 3) escreve via `writeDocToDest` direto; os handlers `watchInsertEvent`/`watchUpdateEvent`/`watchReplaceEvent` não são mais chamados.

```bash
# confirmar que nada importa mais os handlers:
grep -rn "watchInsertEvent\|watchUpdateEvent\|watchReplaceEvent\|insertEvent\|updateEvent\|replaceEvent" src/ test/ | grep -v "test/writeDocWatch"
```

Se o grep só apontar para os próprios arquivos e para `src/core/sync/index.ts`, remover:

```bash
git rm src/core/sync/insertEvent.ts src/core/sync/updateEvent.ts src/core/sync/replaceEvent.ts test/writeDocWatch.test.ts
```

E em `src/core/sync/index.ts`, apagar as linhas que reexportam esses handlers (se existirem). Rodar `bunx tsc --noEmit` e confirmar que não sobrou nenhuma referência (corrigir imports órfãos no `engine.ts` se houver — o engine não deve mais importar os handlers).

- [ ] **Step 2: Passar `flushIntervalMs` no `sync.ts`**

Em `src/commands/sync.ts`, junto de `parallel`/`batchSize` (precedência flag CLI > env > yml > default):

```ts
  const flushIntervalMs =
    toNum(process.env.PULSAR_FLUSH_INTERVAL_MS) ??
    ymlPerf.flushIntervalMs ??
    1000;
```

Incluir na linha de Performance e no `new SyncEngine({...})`:

```ts
  // na customLog de Performance, acrescentar: ` | flushIntervalMs=${flushIntervalMs}`
  // no construtor do engine, somar:
      flushIntervalMs,
```

E em `src/types/parseYml.ts`, no `performance` do `syncYmlSchema`, adicionar:

```ts
        flushIntervalMs: z.number().int().positive().optional(),
```

- [ ] **Step 3: Type-check + smoke**

Run: `bunx tsc --noEmit 2>&1 | grep -E "engine.ts|sync.ts|index.ts|Event.ts" || echo "sem erro tsc nos arquivos tocados"`
Expected: sem erro novo (os 5 pré-existentes de `cli.ts`/`dump.ts`/`parseYml.ts` podem permanecer).

Run: `bunx biome check --write src/commands/sync.ts src/types/parseYml.ts src/core/sync/index.ts`

- [ ] **Step 4: Doc no CLAUDE.md**

Atualizar a seção "Comportamento crítico do sync" → "Stream único (`db.watch`)": acrescentar que o evento agora é **só gatilho** (sem `updateLookup`, `$project` tira o doc), e o dado vem de **re-busca em lote** (`find($in)`), o que torna o watch **imune ao limite de 16MB** do change stream. Citar `flushIntervalMs` (default 1000ms) e que o checkpoint carimba o `lastFlushedToken`. Lógica em `core/sync/changeBuffer.ts` + `engine.ts` (`flush`).

- [ ] **Step 5: Suíte completa + commit**

Run: `bun test`
Expected: PASS (sem os testes dos handlers removidos; com os novos de changeBuffer/refetch).

```bash
git add -A
git commit -m "chore: remove handlers de evento mortos + flushIntervalMs + docs do watch por re-busca"
```

---

## Self-Review

**Spec coverage (desenho 1 do spec):**
- Pipeline sem updateLookup + `$project` → Task 2 + Task 3(f). ✓
- `$match` só por ns.coll; filtro na re-busca → Task 2 + Task 3(h) (`$and` com filter). ✓
- ChangeBuffer dedupe/drain → Task 1. ✓
- Flush: deleteMany / find$in / writeDocToDest / ausente→delete → Task 3(h). ✓
- Checkpoint lastFlushedToken (não stream.resumeToken) → Task 3(e,h). ✓
- Flush por tamanho (batchSize) e por tempo (flushIntervalMs, default 1000) + lock → Task 3(d,e,g,h). ✓
- Substitui updateLookup, sem flag → Task 3(f). ✓
- Mantém 286/reabertura/race do dump (`__sync.hot`) → Task 3(f) preserva o `pump` catch; o `writeDocToDest` marca hot. ✓
- Best-effort por-doc → Task 3(h) try/catch por collection. ✓
- flushIntervalMs config → Task 4(2). ✓
- Handlers mortos removidos → Task 4(1). ✓

**Placeholder scan:** sem TBD/TODO; todo passo tem código/comando.

**Type consistency:** `ChangeBuffer`/`ChangeOp` (Task 1) usados em Task 3; `buildDbWatchPipeline` (Task 2) chamado no `engine.ts` (existente); `writeDocToDest` (Fase 1) usado no flush (Task 3) com origin `"watch:refetch"`; `flushIntervalMs` em `SyncEngineOptions` (Task 3) ↔ `sync.ts`/`parseYml.ts` (Task 4). ✓

**Riscos sinalizados pro review:** (1) checkpoint `lastFlushedToken` — testar restart no meio de backlog; (2) `engine.race`/`engine.restart` podem precisar de ajuste (semântica de delete/checkpoint mudou) → BLOCKED em vez de forçar; (3) memória do flush = 1 lote de docs (≤16MB) — igual ao dump.
