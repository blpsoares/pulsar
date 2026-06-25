# Sync `copyIndexes` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando `copyIndexes: true` no yml do sync, replicar no destino os índices secundários da origem — criando só os que faltam, sem reconstruir os existentes nem abortar o sync em caso de falha.

**Architecture:** Lógica pura isolada em `copyIndexes.ts` (diff por assinatura origem↔destino → `createIndex` só do que falta, erro contido por-índice). O `SyncEngine` chama isso pós-dump (collection que dumpa) ou no startup (collection que resume), agrega contadores e loga por collection + total no painel final.

**Tech Stack:** Bun, TypeScript, mongodb v6, bottleneck, Zod, Biome. Testes: `bun test` contra Mongo real (containers `test:up`).

## Global Constraints

- Runtime Bun; lint Biome (`bunx biome format/check`).
- Falha de índice **nunca** propaga/aborta o sync — best-effort, contida em `failed`.
- Só **adiciona** índices; nunca remove índice que existe só no destino.
- `_id_` sempre pulado.
- Flag default `false` → comportamento atual 100% preservado quando off.
- Sem retry de `createIndex` no mesmo run (re-diff do próximo startup cobre).
- Testes contra Mongo real usam `SRC_URI`/`DST_URI` e helpers de `test/helpers.ts` (`connect`, `uniqueDbName`, `dropDb`).

---

### Task 1: `ensureCollectionIndexes` — diff + create (lógica pura)

**Files:**
- Create: `src/core/sync/copyIndexes.ts`
- Test: `test/copyIndexes.test.ts`

**Interfaces:**
- Consumes: `Collection` do `mongodb`.
- Produces:
  - `type IndexCopyResult = { created: number; skipped: number; failed: { name: string; reason: string }[]; createdNames: string[] }`
  - `async function ensureCollectionIndexes(srcCol: Collection, destCol: Collection): Promise<IndexCopyResult>`
  - Lança erro **só** se `srcCol.listIndexes()` falhar (chamador marca a collection inteira). `destCol.listIndexes()` falhando → retorna `IndexCopyResult` sem criar nada (não lança). `createIndex` falhando → entra em `failed`, não lança.

- [ ] **Step 1: Write the failing test**

```ts
// test/copyIndexes.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { ensureCollectionIndexes } from "../src/core/sync/copyIndexes";
import { connect, DST_URI, dropDb, SRC_URI, uniqueDbName } from "./helpers";

let srcClient: MongoClient;
let dstClient: MongoClient;
let srcDb: Db;
let dstDb: Db;
let srcName: string;
let dstName: string;

beforeAll(async () => {
  srcClient = await connect(SRC_URI);
  dstClient = await connect(DST_URI);
  srcName = uniqueDbName("idx_src");
  dstName = uniqueDbName("idx_dst");
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

async function names(db: Db, coll: string): Promise<string[]> {
  const idx = await db.collection(coll).indexes();
  return idx.map((i) => i.name as string).sort();
}

describe("ensureCollectionIndexes", () => {
  test("destino vazio: cria todos os índices secundários da origem (menos _id_)", async () => {
    await srcDb.collection("c").createIndex({ email: 1 }, { unique: true });
    await srcDb.collection("c").createIndex({ age: -1 });
    await dstDb.collection("c").insertOne({ _id: 1 as any }); // materializa a coll
    await dstDb.collection("c").deleteMany({});

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.failed).toHaveLength(0);
    expect(await names(dstDb, "c")).toContain("email_1");
    expect(await names(dstDb, "c")).toContain("age_-1");
  });

  test("destino já com os mesmos índices: created=0, skipped=2, zero escrita", async () => {
    await srcDb.collection("c").createIndex({ email: 1 }, { unique: true });
    await srcDb.collection("c").createIndex({ age: -1 });
    await dstDb.collection("c").createIndex({ email: 1 }, { unique: true });
    await dstDb.collection("c").createIndex({ age: -1 });

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(2);
  });

  test("índice equivalente com nome diferente no destino: pula (não duplica)", async () => {
    await srcDb.collection("c").createIndex({ status: 1 }, { name: "src_status" });
    await dstDb.collection("c").createIndex({ status: 1 }, { name: "dst_status" });

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    // não criou um segundo índice equivalente
    expect((await dstDb.collection("c").indexes()).filter((i) => i.key?.status === 1)).toHaveLength(1);
  });

  test("conflito de nome (mesmo nome, spec diferente): entra em failed, não lança", async () => {
    await srcDb.collection("c").createIndex({ a: 1 }, { name: "dup" });
    await dstDb.collection("c").createIndex({ b: 1 }, { name: "dup" });

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.name).toBe("dup");
  });

  test("índice TTL (expireAfterSeconds) é replicado fiel", async () => {
    await srcDb.collection("c").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    await dstDb.collection("c").insertOne({ _id: 1 as any });

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(1);
    const idx = (await dstDb.collection("c").indexes()).find((i) => i.key?.createdAt === 1);
    expect(idx?.expireAfterSeconds).toBe(3600);
  });

  test("só _id_ na origem: no-op", async () => {
    await srcDb.collection("c").insertOne({ _id: 1 as any });
    await dstDb.collection("c").insertOne({ _id: 1 as any });

    const res = await ensureCollectionIndexes(srcDb.collection("c"), dstDb.collection("c"));

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/copyIndexes.test.ts`
Expected: FAIL com "Cannot find module '../src/core/sync/copyIndexes'" (ou `ensureCollectionIndexes is not a function`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sync/copyIndexes.ts
import type { Collection, Document } from "mongodb";

export type IndexCopyResult = {
  created: number;
  skipped: number;
  failed: { name: string; reason: string }[];
  createdNames: string[];
};

// Campos meta do listIndexes que NÃO entram nem na assinatura nem nas opções de
// createIndex (versões internas variam por versão de servidor e gerariam falso
// "faltando" → conflito de nome).
const STRIP = new Set([
  "v",
  "key",
  "name",
  "ns",
  "background",
  "textIndexVersion",
  "2dsphereIndexVersion",
]);

/** Opções de um índice (unique, sparse, partial, collation, expireAfterSeconds,
 *  weights, default_language, wildcardProjection...), sem os campos meta. */
function indexOptions(idx: Document): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(idx)) {
    if (!STRIP.has(k)) opts[k] = val;
  }
  return opts;
}

/** JSON canônico (chaves ordenadas recursivamente) p/ comparar índices por valor. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Assinatura = key + opções (ignora nome/versões) → equivalentes batem mesmo
 *  com nomes diferentes. */
function signature(idx: Document): string {
  return stableStringify({ key: idx.key, ...indexOptions(idx) });
}

/**
 * Garante no destino os índices secundários da origem. Faz um diff por
 * assinatura: cria SÓ os que faltam. Erro de `createIndex` é contido por-índice
 * (entra em `failed`). `srcCol.listIndexes()` falhando propaga (chamador trata a
 * collection inteira); `destCol.listIndexes()` falhando → não cria nada.
 */
export async function ensureCollectionIndexes(
  srcCol: Collection,
  destCol: Collection,
): Promise<IndexCopyResult> {
  const result: IndexCopyResult = { created: 0, skipped: 0, failed: [], createdNames: [] };

  // Origem: se isto falhar, propaga (a collection inteira vira falha no engine).
  const srcIdx = (await srcCol.listIndexes().toArray()).filter((i) => i.name !== "_id_");
  if (srcIdx.length === 0) return result;

  // Destino: se falhar, não dá pra diferenciar com segurança → não cria nada.
  let destSigs: Set<string>;
  try {
    const destIdx = await destCol.listIndexes().toArray();
    destSigs = new Set(destIdx.map(signature));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.failed.push({ name: "*listIndexes(dest)", reason });
    return result;
  }

  for (const idx of srcIdx) {
    if (destSigs.has(signature(idx))) {
      result.skipped += 1;
      continue;
    }
    try {
      await destCol.createIndex(idx.key as Document, {
        name: idx.name as string,
        ...indexOptions(idx),
      });
      result.created += 1;
      result.createdNames.push(idx.name as string);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ name: idx.name as string, reason });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/copyIndexes.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/copyIndexes.ts test/copyIndexes.test.ts
git add src/core/sync/copyIndexes.ts test/copyIndexes.test.ts
git commit -m "feat: ensureCollectionIndexes (diff por assinatura + create contido)"
```

---

### Task 2: Integrar no `SyncEngine` (flag, contadores, chamada pós-dump e no resume)

**Files:**
- Modify: `src/core/sync/engine.ts`
- Test: `test/engine.copyIndexes.test.ts`

**Interfaces:**
- Consumes: `ensureCollectionIndexes`, `IndexCopyResult` da Task 1; `customLog` de `../../utils/customLog`.
- Produces (campos públicos novos no `SyncEngine`, lidos pelo `sync.ts` na Task 3):
  - `indexesCreated: number`
  - `indexesSkipped: number`
  - `indexFailures: { coll: string; name: string }[]`
  - opção `copyIndexes?: boolean` em `SyncEngineOptions` (default `false`).

- [ ] **Step 1: Write the failing test**

```ts
// test/engine.copyIndexes.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { SyncEngine } from "../src/core/sync/engine";
import { setLogConfig } from "../src/utils/logConfig";
import { connect, DST_URI, dropDb, seed, SRC_URI, uniqueDbName } from "./helpers";

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
  srcName = uniqueDbName("eci_src");
  dstName = uniqueDbName("eci_dst");
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

describe("SyncEngine — copyIndexes", () => {
  test("copyIndexes:true replica o índice da origem após o dump", async () => {
    await seed(srcDb, "colA", 10);
    await srcDb.collection("colA").createIndex({ v: 1 });

    const engine = new SyncEngine({
      sourceDb: srcDb,
      destDb: dstDb,
      collections: [{ name: "colA" }],
      copyIndexes: true,
      checkpointIntervalMs: 100,
    });
    await engine.start();

    const idx = (await dstDb.collection("colA").indexes()).find((i) => i.key?.v === 1);
    expect(idx).toBeDefined();
    expect(engine.indexesCreated).toBe(1);

    await engine.stop();
  });

  test("default (sem copyIndexes): NÃO replica índices", async () => {
    await seed(srcDb, "colA", 10);
    await srcDb.collection("colA").createIndex({ v: 1 });

    const engine = new SyncEngine({
      sourceDb: srcDb,
      destDb: dstDb,
      collections: [{ name: "colA" }],
      checkpointIntervalMs: 100,
    });
    await engine.start();

    const idx = (await dstDb.collection("colA").indexes()).find((i) => i.key?.v === 1);
    expect(idx).toBeUndefined();
    expect(engine.indexesCreated).toBe(0);

    await engine.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/engine.copyIndexes.test.ts`
Expected: FAIL (`copyIndexes` não é opção / `indexesCreated` undefined → índice não criado).

- [ ] **Step 3: Implement — opção, contadores, helper e chamadas**

Em `src/core/sync/engine.ts`:

(a) Importar a Task 1 e `customLog` (logo abaixo dos imports existentes):

```ts
import { customLog } from "../../utils/customLog";
import { ensureCollectionIndexes } from "./copyIndexes";
```

(b) Adicionar `copyIndexes` ao `SyncEngineOptions`:

```ts
export type SyncEngineOptions = {
  sourceDb: Db;
  destDb: Db;
  collections: EngineCollection[];
  parallel?: number;
  batchSize?: number;
  full?: boolean;
  checkpointIntervalMs?: number;
  /** Janela máx. p/ considerar um resume estabelecido (e p/ aguardar token). */
  resumeProbeMs?: number;
  /** Replicar no destino os índices secundários da origem (default false). */
  copyIndexes?: boolean;
};
```

(c) Campos públicos novos (junto de `failedDumps`/`docsDumped`):

```ts
  /** Cópia de índices (quando copyIndexes on): agregados p/ o painel final. */
  indexesCreated = 0;
  indexesSkipped = 0;
  readonly indexFailures: { coll: string; name: string }[] = [];
```

(d) No construtor, somar `copyIndexes` ao `this.opts` (dentro do objeto):

```ts
      resumeProbeMs: options.resumeProbeMs ?? RESUME_PROBE_MS,
      copyIndexes: options.copyIndexes ?? false,
```

(e) Novo método privado `copyIndexesFor` (perto de `runDump`):

```ts
  /** Garante os índices da origem no destino p/ uma collection; agrega e loga. */
  private async copyIndexesFor(col: EngineCollection): Promise<void> {
    const route = this.routes.get(col.name);
    if (!route) return;
    let res: Awaited<ReturnType<typeof ensureCollectionIndexes>>;
    try {
      res = await ensureCollectionIndexes(route.srcCol, route.destCol);
    } catch (err) {
      // listIndexes da origem falhou → a collection inteira falha na cópia.
      const reason = err instanceof Error ? err.message : String(err);
      this.indexFailures.push({ coll: col.name, name: "*" });
      customLog("warn", `[${col.name}] cópia de índices falhou: ${reason}`);
      return;
    }
    this.indexesCreated += res.created;
    this.indexesSkipped += res.skipped;
    for (const f of res.failed) this.indexFailures.push({ coll: col.name, name: f.name });
    const parts = [`${res.created} índices criados`, `${res.skipped} já existiam`];
    if (res.failed.length > 0) {
      parts.push(`${res.failed.length} FALHOU (${res.failed.map((f) => f.name).join(", ")})`);
    }
    customLog("info", `[${col.name}] ${parts.join(", ")}`);
  }
```

(f) Em `runDump`, dentro do ramo `if (ok)`, após limpar a fronteira:

```ts
    if (ok) {
      await markDumpCompleted(this.opts.destDb, col.name);
      // dump concluído: não deve ressuscitar como incompleto no flush do stop.
      this.lastFrontier.delete(col.name);
      // índices DEPOIS do dump: build em lote único é mais rápido que manter
      // índice a cada insert (igual ao mongorestore).
      if (this.opts.copyIndexes) await this.copyIndexesFor(col);
    } else {
```

(g) No `start()`, após o `await Promise.all(... runDump ...)` e ANTES de limpar `deletedIds`, copiar índices das collections que RESUMIRAM (não dumparam), estranguladas pelo mesmo `parallel`:

```ts
    // collections que RESUMIRAM (dados já no destino): completa índices faltantes
    // no startup. As que dumparam já trataram índices no runDump.
    if (this.opts.copyIndexes) {
      const resumedCols = plans.filter((p) => !p.needsDump).map((p) => p.col);
      const idxLimiter = new Bottleneck({ maxConcurrent: this.opts.parallel });
      await Promise.all(
        resumedCols.map((c) => idxLimiter.schedule(() => this.copyIndexesFor(c))),
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/engine.copyIndexes.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Run the full engine suite (no regression)**

Run: `bun test test/engine.dump.test.ts test/engine.restart.test.ts`
Expected: PASS (comportamento default preservado — copyIndexes off por padrão).

- [ ] **Step 6: Lint + commit**

```bash
bunx biome check --write src/core/sync/engine.ts test/engine.copyIndexes.test.ts
git add src/core/sync/engine.ts test/engine.copyIndexes.test.ts
git commit -m "feat: SyncEngine copia índices da origem (pós-dump e no resume) com contadores"
```

---

### Task 3: yml schema, fiação no `sync.ts` e linha no painel final

**Files:**
- Modify: `src/types/parseYml.ts:33-61` (schema da sync)
- Modify: `src/commands/sync.ts` (ler flag, passar ao engine, painel, log)
- Modify: `src/utils/progressManager.ts:204-254` (`renderClosingPanel`)
- Modify: `configs/test-sync.yml` (exemplo documentado — opcional, ver Step)

**Interfaces:**
- Consumes: `SyncEngine.indexesCreated/indexesSkipped/indexFailures` da Task 2.
- Produces: campo `copyIndexes?: boolean` em `SyncYmlOptions.command.sync`; campo opcional `indexes` em `renderClosingPanel`.

- [ ] **Step 1: Schema — adicionar `copyIndexes` ao `syncYmlSchema`**

Em `src/types/parseYml.ts`, dentro de `sync: z.object({ ... })`, após `collections`:

```ts
      collections: z.array(syncCollectionEntrySchema).optional(),
      copyIndexes: z.boolean().optional(),
```

- [ ] **Step 2: `renderClosingPanel` — campo e linha de índices**

Em `src/utils/progressManager.ts`, no parâmetro de `renderClosingPanel`, adicionar campo opcional:

```ts
export function renderClosingPanel(d: {
  total: number;
  resumed: number;
  dumped: number;
  dumpedNames: string[];
  failed: string[];
  docsDumped: number;
  durationMs: number;
  stopHint: string;
  indexes?: { created: number; skipped: number; failed: { coll: string; name: string }[] };
}): string {
```

E logo após o bloco que faz `lines.push(row(\`Docs copiados no dump ...\`), row(\`Duração ...\`), ...)`, ANTES da linha separadora `║${"─".repeat(W)}║`, inserir a linha de índices condicional. Trocar o `lines.push(...)` final por:

```ts
  if (d.indexes) {
    const f = d.indexes.failed;
    const fLabel = f.length > 0 ? ` · falharam: ${f.length} (${[...new Set(f.map((x) => x.coll))].join(", ")})` : "";
    lines.push(
      row(`Índices ... criados: ${d.indexes.created} · já existiam: ${d.indexes.skipped}${fLabel}`),
    );
  }
  lines.push(
    `║${"─".repeat(W)}║`,
    row("MODO: tempo real · replicando mudanças ao vivo"),
    row(d.stopHint),
    `╚${"═".repeat(W)}╝`,
  );
  return lines.join("\n");
```

(Remover o `lines.push(...)` antigo que continha a separadora + MODO + stopHint + borda, substituído pelo bloco acima.)

- [ ] **Step 3: `sync.ts` — ler flag, passar ao engine, log e painel**

(a) Após `const full = Boolean(cliParams.full);`:

```ts
  const copyIndexes = Boolean(options.command.sync.copyIndexes ?? false);
```

(b) Na `customLog` de Performance, incluir o estado:

```ts
  customLog(
    "info",
    `Performance: parallel=${parallel} | batchSize=${batchSize}${full ? " | --full (re-dump forçado)" : ""}${copyIndexes ? " | copyIndexes=on" : ""}`,
  );
```

(c) Passar a opção ao construir o engine:

```ts
    engine = new SyncEngine({
      sourceDb: db,
      destDb,
      collections,
      parallel,
      batchSize,
      full,
      copyIndexes,
    });
```

(d) No `renderClosingPanel({...})`, adicionar o campo `indexes` só quando a flag está on:

```ts
    const panel = renderClosingPanel({
      total,
      resumed: engine.resumedCount,
      dumped: engine.dumpsPlanned - falhas.length,
      dumpedNames: engine.dumpedNames,
      failed: falhas,
      docsDumped: engine.docsDumped,
      durationMs: performance.now() - t0,
      stopHint,
      ...(copyIndexes
        ? {
            indexes: {
              created: engine.indexesCreated,
              skipped: engine.indexesSkipped,
              failed: engine.indexFailures,
            },
          }
        : {}),
    });
```

(e) Incluir o resumo de índices no `logger.info("SYNC PRONTO...")` (append condicional):

```ts
    logger.info(
      `SYNC PRONTO: ${total - falhas.length}/${total} em dia | ${engine.resumedCount} retomadas | ${engine.dumpsPlanned - falhas.length} dump | ${engine.docsDumped} docs | falhas: ${falhas.join(",") || "0"}${copyIndexes ? ` | índices: +${engine.indexesCreated} (${engine.indexesSkipped} já existiam, ${engine.indexFailures.length} falhas)` : ""}`,
    );
```

- [ ] **Step 4: Type-check + lint**

Run: `bunx tsc --noEmit && bunx biome check --write src/types/parseYml.ts src/commands/sync.ts src/utils/progressManager.ts`
Expected: sem erros de tipo; Biome limpo.

- [ ] **Step 5: Smoke do parse do yml (schema aceita a flag)**

Adicionar `copyIndexes: true` em `configs/test-sync.yml` (sob `command.sync`) e rodar:

Run: `bun run src/cli.ts sync configs/test-sync.yml --verbose` (com `bun run test:up` ativo) por alguns segundos; confirmar no log a linha `Performance: ... | copyIndexes=on` e, ao fim do dump, a linha `Índices ...` no painel. Encerrar com Ctrl+C.
Expected: parse OK (sem erro Zod), painel mostra a linha de índices.

- [ ] **Step 6: Commit**

```bash
git add src/types/parseYml.ts src/commands/sync.ts src/utils/progressManager.ts configs/test-sync.yml
git commit -m "feat: flag copyIndexes no yml do sync + linha de índices no painel final"
```

---

### Task 4: Documentação (CLAUDE.md)

**Files:**
- Modify: `CLAUDE.md` (seção do sync e formato dos YMLs)

**Interfaces:** nenhuma (docs).

- [ ] **Step 1: Documentar a flag**

Em `CLAUDE.md`, na seção "Formato dos YMLs" (bloco do sync), adicionar a linha de exemplo sob `command.sync`:

```yaml
    logging:
      verbose: false
      progress: true
    copyIndexes: false   # default false; true replica índices secundários da origem no destino
```

E adicionar um parágrafo curto na seção de comportamento do sync (perto de "Campos adicionados nos docs do destino"):

```markdown
### Cópia de índices (`copyIndexes`)

O copy doc-a-doc do sync **não** traz os índices secundários da origem (só os dados; `migrate` via mongorestore traz). Com `copyIndexes: true` no yml, o sync replica os índices da origem no destino: faz um **diff por assinatura** (key+opções) e cria **só os que faltam** — num banco já migrado, a maioria das collections nem recebe escrita. Collection que dumpa cria o índice **depois** do dump (build em lote, igual mongorestore); collection que resume completa no startup. Falha de `createIndex` (ex.: conflito de nome) é **contida** (loga, não aborta o sync) e re-tentada no próximo startup. Nunca remove índices que existem só no destino. Painel final mostra `Índices · criados/já existiam/falharam`. Lógica em `core/sync/copyIndexes.ts`, testes em `test/copyIndexes.test.ts` e `test/engine.copyIndexes.test.ts`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: copyIndexes no CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- Diff por assinatura + create só do que falta → Task 1. ✓
- Backstop (cria com nome da origem) → Task 1 (`name: idx.name`). ✓
- Ordenação (dumpa→pós-dump; resume→startup) → Task 2 (f) e (g). ✓
- Matriz de falhas (listIndexes origem propaga; dest não cria; createIndex contido) → Task 1 + Task 2 `copyIndexesFor`. ✓
- Flag global default false → Task 2 (b/d), Task 3 Step 1/3. ✓
- Sem retry no run (re-diff próximo startup) → garantido por não retentar; documentado Task 4. ✓
- Log por collection + total no painel → Task 2 `copyIndexesFor` (por coll), Task 3 Step 2/3 (painel + logger.info). ✓
- Testes contra Mongo real → Task 1 (6 casos) + Task 2 (2 casos). ✓
- Fora de escopo (override por coll, drop de índices, retry) → não implementados. ✓

**Placeholder scan:** nenhum TBD/TODO; todo passo tem código/comando concretos.

**Type consistency:** `IndexCopyResult` (Task 1) ↔ uso em `copyIndexesFor` (Task 2) ↔ `indexesCreated/indexesSkipped/indexFailures` (Task 2) ↔ campo `indexes` do painel (Task 3). `ensureCollectionIndexes(srcCol, destCol)` mesma assinatura em todos os pontos. ✓
