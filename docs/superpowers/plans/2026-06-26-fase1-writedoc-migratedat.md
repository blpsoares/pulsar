# Fase 1 — `writeDoc` unificado + `__migratedAt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda escrita no destino (dump e watch) passa por uma função única que grava o doc com semântica de **replace** e injeta `__migratedAt` (BSON `Date`) **imutável** — âncora de TTL pra qualquer collection, independente do tipo de `_id`.

**Architecture:** Um helper puro `buildReplaceWithMigratedAt(docWithMeta)` devolve um pipeline de update (`$replaceWith` + `$mergeObjects` + `$literal` + `$ifNull('$__migratedAt','$$NOW')`). O dump usa esse pipeline nas operações do `bulkWrite` (mantendo a decisão hot/hash e o guard de corrida); os handlers do watch usam o `writeDocToDest` (1-a-1). NÃO mexe na arquitetura do watch (updateLookup segue ligado nesta fase — isso é a Fase 2).

**Tech Stack:** Bun, TypeScript, mongodb v6, Biome. Testes: `bun test` contra Mongo real (containers `bun run test:up`).

## Global Constraints

- `__migratedAt`: campo na **raiz**, BSON `Date`, gravado na 1ª escrita, **nunca** atualizado.
- Mecanismo imutável: pipeline `{ $ifNull: ["$__migratedAt", "$$NOW"] }` — `$$NOW` é BSON `Date`.
- `$literal` embrulha o doc da origem (valores como `"$x"`/`"R$ 5"` NÃO podem virar expressão).
- Semântica de **replace** (`$replaceWith`): campo removido na origem some no destino.
- Guard de corrida do dump preservado: update não sobrescreve doc `__sync.hot: true`.
- `__sync` (hot/ts/hash) e `origin` **inalterados** — só adiciona `__migratedAt`.
- Nomes genéricos nos testes (sem nome de ambiente/produto real).
- Testes contra Mongo real: `SRC_URI`/`DST_URI` + helpers de `test/helpers.ts`.

---

### Task 1: helper `buildReplaceWithMigratedAt` + `writeDocToDest`

**Files:**
- Create: `src/core/sync/writeDoc.ts`
- Test: `test/writeDoc.test.ts`

**Interfaces:**
- Consumes: `addFieldsOnMongoDocument(doc, origin, hot)` de `../../utils/mongo` (já existe; devolve `{...doc, __sync:{hot,ts,hash}, origin}`).
- Produces:
  - `buildReplaceWithMigratedAt(docWithMeta: Document): Document[]` — pipeline de update.
  - `writeDocToDest(destCol: Collection, sourceDoc: Document, origin: string, hot?: boolean): Promise<void>` — escreve 1 doc (replace + `__migratedAt` imutável).

- [ ] **Step 1: Write the failing test**

```ts
// test/writeDoc.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { writeDocToDest } from "../src/core/sync/writeDoc";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
  client = await connect(DST_URI);
  dbName = uniqueDbName("writedoc");
  db = client.db(dbName);
});

afterAll(async () => {
  await dropDb(client, dbName);
  await client.close();
});

beforeEach(async () => {
  await db.dropDatabase();
});

describe("writeDocToDest", () => {
  test("1ª escrita grava o doc + __migratedAt como BSON Date", async () => {
    await writeDocToDest(db.collection("c"), { _id: 1 as any, v: 10 }, "dump", false);
    const d = await db.collection("c").findOne({ _id: 1 as any });
    expect(d?.v).toBe(10);
    expect(d?.__migratedAt).toBeInstanceOf(Date);
    expect(d?.__sync?.hash).toBeDefined();
  });

  test("2ª escrita PRESERVA o __migratedAt original (imutável)", async () => {
    await writeDocToDest(db.collection("c"), { _id: 1 as any, v: 10 }, "dump", false);
    const first = await db.collection("c").findOne({ _id: 1 as any });
    const firstAt = first?.__migratedAt as Date;
    await new Promise((r) => setTimeout(r, 15));
    await writeDocToDest(db.collection("c"), { _id: 1 as any, v: 99 }, "watch:update", true);
    const second = await db.collection("c").findOne({ _id: 1 as any });
    expect(second?.v).toBe(99); // doc atualizado
    expect((second?.__migratedAt as Date).getTime()).toBe(firstAt.getTime()); // data NÃO mudou
  });

  test("replace remove campo que sumiu da origem", async () => {
    await writeDocToDest(db.collection("c"), { _id: 1 as any, a: 1, b: 2 }, "dump", false);
    await writeDocToDest(db.collection("c"), { _id: 1 as any, a: 1 }, "watch:replace", true);
    const d = await db.collection("c").findOne({ _id: 1 as any });
    expect(d?.b).toBeUndefined(); // b removido (semântica de replace)
  });

  test("valor com '$' é gravado literal, não vira expressão", async () => {
    await writeDocToDest(db.collection("c"), { _id: 1 as any, preco: "$5,00", op: "$inc" }, "dump", false);
    const d = await db.collection("c").findOne({ _id: 1 as any });
    expect(d?.preco).toBe("$5,00");
    expect(d?.op).toBe("$inc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/writeDoc.test.ts`
Expected: FAIL com "Cannot find module '../src/core/sync/writeDoc'".

- [ ] **Step 3: Write the implementation**

```ts
// src/core/sync/writeDoc.ts
import type { Collection, Document } from "mongodb";
import { addFieldsOnMongoDocument } from "../../utils/mongo";

/**
 * Pipeline de update que:
 * 1. Substitui o doc do destino pela versão da origem (com __sync/origin) —
 *    semântica de REPLACE, então campo removido na origem some no destino.
 * 2. Grava __migratedAt como BSON Date na 1ª vez e PRESERVA nas demais
 *    (`$ifNull`). `$$NOW` é a data do servidor (BSON Date).
 * `$literal` embrulha o doc pra valores como "$x"/"R$ 5" NÃO virarem expressão.
 */
export function buildReplaceWithMigratedAt(docWithMeta: Document): Document[] {
  return [
    {
      $replaceWith: {
        $mergeObjects: [
          { $literal: docWithMeta },
          { __migratedAt: { $ifNull: ["$__migratedAt", "$$NOW"] } },
        ],
      },
    },
  ];
}

/**
 * Escreve um doc da origem no destino (replace + __migratedAt imutável). Usado
 * pelos handlers do watch (1-a-1); o dump usa o MESMO pipeline em bulkWrite.
 */
export async function writeDocToDest(
  destCol: Collection,
  sourceDoc: Document,
  origin: string,
  hot = true,
): Promise<void> {
  const docWithMeta = addFieldsOnMongoDocument(sourceDoc, origin, hot);
  await destCol.updateOne(
    { _id: sourceDoc._id },
    buildReplaceWithMigratedAt(docWithMeta),
    { upsert: true },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/writeDoc.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/writeDoc.ts test/writeDoc.test.ts
git add src/core/sync/writeDoc.ts test/writeDoc.test.ts
git commit -m "feat: writeDocToDest (replace + __migratedAt imutável via pipeline)"
```

---

### Task 2: handlers do watch usam `writeDocToDest`

**Files:**
- Modify: `src/core/sync/insertEvent.ts`
- Modify: `src/core/sync/updateEvent.ts`
- Modify: `src/core/sync/replaceEvent.ts`
- Test: `test/writeDocWatch.test.ts`

**Interfaces:**
- Consumes: `writeDocToDest` (Task 1).
- Produces: handlers com a mesma assinatura de hoje (`watchInsertEvent(destCollection, rawDocument)` etc.), agora escrevendo via `writeDocToDest`.

- [ ] **Step 1: Write the failing test**

```ts
// test/writeDocWatch.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { watchInsertEvent } from "../src/core/sync/insertEvent";
import { watchUpdateEvent } from "../src/core/sync/updateEvent";
import { connect, DST_URI, dropDb, uniqueDbName } from "./helpers";
import { setLogConfig } from "../src/utils/logConfig";

let client: MongoClient;
let db: Db;
let dbName: string;

beforeAll(async () => {
  setLogConfig({ verbose: false, progress: false });
  client = await connect(DST_URI);
  dbName = uniqueDbName("wdwatch");
  db = client.db(dbName);
});

afterAll(async () => {
  await dropDb(client, dbName);
  await client.close();
});

beforeEach(async () => {
  await db.dropDatabase();
});

describe("watch handlers escrevem __migratedAt imutável", () => {
  test("insert grava __migratedAt; update posterior preserva", async () => {
    await watchInsertEvent(db.collection("c"), { _id: 1 as any, v: 1 });
    const first = await db.collection("c").findOne({ _id: 1 as any });
    expect(first?.__migratedAt).toBeInstanceOf(Date);
    const at = (first?.__migratedAt as Date).getTime();

    await new Promise((r) => setTimeout(r, 15));
    await watchUpdateEvent(db.collection("c"), { _id: 1 as any, v: 2 });
    const second = await db.collection("c").findOne({ _id: 1 as any });
    expect(second?.v).toBe(2);
    expect((second?.__migratedAt as Date).getTime()).toBe(at);
    expect(second?.origin).toBe("watch:update");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/writeDocWatch.test.ts`
Expected: FAIL (`__migratedAt` undefined — handlers ainda usam o write antigo).

- [ ] **Step 3: Refactor os três handlers**

Em `src/core/sync/insertEvent.ts` — trocar o corpo da escrita (mantendo o guard de `rawDocument` e o log):

```ts
import type { Document, Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchInsertEvent(
  destCollection: Collection,
  rawDocument: Document,
) {
  const { collectionName } = destCollection;
  if (!rawDocument) {
    customLog("warn", `[${collectionName}] insert: fullDocument not found, skipping.`);
    return;
  }

  try {
    await writeDocToDest(destCollection, rawDocument, "watch:insert");
  } catch (error) {
    customLog("error", `watch:insert falhou | collection: ${collectionName} | _id: ${rawDocument._id}`, false, error);
    return;
  }

  const msg = `watch:insert | collection: ${collectionName} | _id: ${rawDocument._id}`;
  logger.info(msg);
  if (getLogConfig().verbose) terminalLog("info", msg);
}
```

Em `src/core/sync/updateEvent.ts` — idêntico, trocando `origin` por `"watch:update"`:

```ts
import type { Document, Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchUpdateEvent(
  destCollection: Collection,
  rawDocument: Document,
) {
  const { collectionName } = destCollection;
  if (!rawDocument) {
    customLog("warn", `[${collectionName}] update: fullDocument not found, skipping.`);
    return;
  }

  try {
    await writeDocToDest(destCollection, rawDocument, "watch:update");
  } catch (error) {
    customLog("error", `watch:update falhou | collection: ${collectionName} | _id: ${rawDocument._id}`, false, error);
    return;
  }

  const msg = `watch:update | collection: ${collectionName} | _id: ${rawDocument._id}`;
  logger.info(msg);
  if (getLogConfig().verbose) terminalLog("info", msg);
}
```

Em `src/core/sync/replaceEvent.ts` — idêntico, `origin` `"watch:replace"`:

```ts
import type { Document, Collection } from "mongodb";
import { customLog, logger, terminalLog } from "../../utils/customLog";
import { getLogConfig } from "../../utils/logConfig";
import { writeDocToDest } from "./writeDoc";

export async function watchReplaceEvent(
  destCollection: Collection,
  rawDocument: Document,
) {
  const { collectionName } = destCollection;
  if (!rawDocument) {
    customLog("warn", `[${collectionName}] replace: fullDocument not found, skipping.`);
    return;
  }

  try {
    await writeDocToDest(destCollection, rawDocument, "watch:replace");
  } catch (error) {
    customLog("error", `watch:replace falhou | collection: ${collectionName} | _id: ${rawDocument._id}`, false, error);
    return;
  }

  const msg = `watch:replace | collection: ${collectionName} | _id: ${rawDocument._id}`;
  logger.info(msg);
  if (getLogConfig().verbose) terminalLog("info", msg);
}
```

- [ ] **Step 4: Run new test + watch regression**

Run: `bun test test/writeDocWatch.test.ts`
Expected: PASS.

Run: `bun test test/engine.dbwatch.test.ts test/engine.race.test.ts`
Expected: PASS (handlers seguem escrevendo doc + __sync/origin como antes).

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/insertEvent.ts src/core/sync/updateEvent.ts src/core/sync/replaceEvent.ts test/writeDocWatch.test.ts
git add src/core/sync/insertEvent.ts src/core/sync/updateEvent.ts src/core/sync/replaceEvent.ts test/writeDocWatch.test.ts
git commit -m "feat: handlers do watch escrevem via writeDocToDest (__migratedAt)"
```

---

### Task 3: dump `processBatch` grava `__migratedAt` (pipeline no bulkWrite)

**Files:**
- Modify: `src/core/sync/dumpEvent.ts` (função `processBatch`, ~linha 150-210)
- Test: `test/dumpMigratedAt.test.ts`

**Interfaces:**
- Consumes: `buildReplaceWithMigratedAt` (Task 1), `addFieldsOnMongoDocument` (existente).
- Produces: nenhuma assinatura nova; `dumpCollections` inalterado por fora.

- [ ] **Step 1: Write the failing test**

```ts
// test/dumpMigratedAt.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db, MongoClient } from "mongodb";
import { dumpCollections } from "../src/core/sync/dumpEvent";
import { connect, DST_URI, dropDb, SRC_URI, seed, uniqueDbName } from "./helpers";
import { setLogConfig } from "../src/utils/logConfig";

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
  srcName = uniqueDbName("dma_src");
  dstName = uniqueDbName("dma_dst");
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

describe("dump grava __migratedAt", () => {
  test("dump inicial grava __migratedAt Date; re-dump preserva", async () => {
    await seed(srcDb, "c", 5);
    await dumpCollections(srcDb.collection("c"), dstDb.collection("c"), []);
    const first = await dstDb.collection("c").findOne({ _id: 0 as any });
    expect(first?.__migratedAt).toBeInstanceOf(Date);
    const at = (first?.__migratedAt as Date).getTime();

    // muda um doc na origem e re-dumpa: __migratedAt deve ser preservado
    await srcDb.collection("c").updateOne({ _id: 0 as any }, { $set: { v: 999 } });
    await new Promise((r) => setTimeout(r, 15));
    await dumpCollections(srcDb.collection("c"), dstDb.collection("c"), []);
    const second = await dstDb.collection("c").findOne({ _id: 0 as any });
    expect(second?.v).toBe(999); // re-dump atualizou o dado
    expect((second?.__migratedAt as Date).getTime()).toBe(at); // data preservada
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dumpMigratedAt.test.ts`
Expected: FAIL (`__migratedAt` undefined — `processBatch` ainda usa replaceOne/$set sem o campo).

- [ ] **Step 3: Trocar as operações em `processBatch`**

Em `src/core/sync/dumpEvent.ts`, adicionar o import no topo (junto dos outros):

```ts
import { buildReplaceWithMigratedAt } from "./writeDoc";
```

Dentro de `processBatch`, trocar os dois ramos que empurram operações. O ramo de INSERT (doc ausente):

```ts
    if (!destDoc) {
      ops.push({
        updateOne: {
          filter: { _id: coldDocument._id },
          update: buildReplaceWithMigratedAt(newDocument),
          upsert: true,
        },
      });
      stats.inserted++;
      continue;
    }
```

E o ramo de UPDATE (hash diferente) — mantendo o guard de corrida `__sync.hot: { $ne: true }`:

```ts
    ops.push({
      updateOne: {
        filter: { _id: coldDocument._id, "__sync.hot": { $ne: true } },
        update: buildReplaceWithMigratedAt(newDocument),
      },
    });
    stats.updated++;
```

(O ramo de SKIP e o `bulkWrite(ops, { ordered: false })` ficam iguais. `newDocument` continua vindo de `addFieldsOnMongoDocument(coldDocument, "dump", false)`.)

- [ ] **Step 4: Run new test + dump regression (inclui volumetria)**

Run: `bun test test/dumpMigratedAt.test.ts`
Expected: PASS.

Run: `bun test test/engine.dump.test.ts test/engine.dumpResume.test.ts test/engine.restart.test.ts test/engine.full.test.ts test/engine.volumetria.test.ts test/dumpProgress.test.ts test/dumpResume.test.ts`
Expected: PASS. (Atenção ao `engine.volumetria`: confirmar que o pipeline-update no bulkWrite não regrediu o tempo — se o teste de velocidade falhar, reportar como BLOCKED com os números.)

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check --write src/core/sync/dumpEvent.ts test/dumpMigratedAt.test.ts
git add src/core/sync/dumpEvent.ts test/dumpMigratedAt.test.ts
git commit -m "feat: dump grava __migratedAt imutável (pipeline-update no bulkWrite)"
```

---

### Task 4: documentação (CLAUDE.md)

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** nenhuma.

- [ ] **Step 1: Documentar o campo**

Em `CLAUDE.md`, na seção "Campos adicionados nos docs do destino", adicionar após o bloco `__sync`/`origin`:

```markdown
### `__migratedAt` — âncora de TTL

Toda escrita no destino (dump e watch) grava um campo `__migratedAt` na **raiz**, do tipo BSON `Date`, com a data em que o doc **entrou na réplica**. É **imutável**: gravado na 1ª escrita e preservado nas demais (via pipeline `$ifNull("$__migratedAt", "$$NOW")` em `core/sync/writeDoc.ts`). Serve de âncora pro comando `ttl` em collections cujo `_id` **não** é `ObjectId` (onde `--derive-from-id` não funciona):

​```sh
pulsar ttl --uri '...' --db x --all --field __migratedAt --expire 30d
​```

Não é a data de criação real em produção — é "quando sincronizou". Pra limpeza da réplica (expirar X tempo após entrar), é a âncora correta. Lógica em `core/sync/writeDoc.ts`, testes em `test/writeDoc.test.ts`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: __migratedAt no CLAUDE.md"
```

---

## Self-Review

**Spec coverage (desenho 2 / `__migratedAt` do spec):**
- Campo raiz, BSON Date, imutável → Task 1 (`$ifNull/$$NOW`). ✓
- Set na 1ª escrita (dump E watch) → Task 2 (watch) + Task 3 (dump). ✓
- Mecanismo `$ifNull` atômico sem leitura extra → Task 1. ✓
- `$literal` p/ valores `"$..."` → Task 1 (teste dedicado). ✓
- Semântica replace (campo removido some) → Task 1 (teste) + Task 3 (dump). ✓
- Cobre qualquer `_id` / TTL aponta pro campo → Task 4 (docs). ✓
- `__sync` inalterado → nenhuma task toca `addFieldsOnMongoDocument`. ✓
- Guard de corrida do dump preservado → Task 3 (filtro `__sync.hot: $ne true`). ✓

**Fora de escopo nesta fase (vai pra Fase 2):** pipeline do watch sem updateLookup, buffer/re-busca, checkpoint `lastFlushedToken`. Esta fase mantém o watch como está.

**Placeholder scan:** nenhum TBD/TODO; todo passo tem código/comando concretos.

**Type consistency:** `buildReplaceWithMigratedAt(docWithMeta)` e `writeDocToDest(destCol, sourceDoc, origin, hot?)` (Task 1) usados igualzinho em Task 2 (watch) e Task 3 (dump import do `buildReplaceWithMigratedAt`). `addFieldsOnMongoDocument(doc, origin, hot)` assinatura existente preservada. ✓
