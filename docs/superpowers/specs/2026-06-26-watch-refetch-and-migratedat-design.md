# Watch como gatilho + re-busca em lote (16MB-safe) e campo imutável `__migratedAt`

**Data:** 2026-06-26
**Status:** aprovado, pronto p/ plano

## Problema

Duas dores, resolvidas juntas porque compartilham a **lógica de escrita** do sync:

### 1. Eventos de change stream > 16MB derrubam o watch
O `sync` abre o `db.watch` com `fullDocument: "updateLookup"`. O evento de update carrega **o documento inteiro** (`fullDocument`) **+** o delta (`updateDescription`). Num doc grande (perto de 16MB) com update grande, o evento estoura o limite **duro** de 16MB do MongoDB:
```
WATCH:db.watch Executor error ... Serializing Document failed :: Size 27698137 exceeds maximum 16793600
```
O stream cai e reabre em loop, travando a replicação daquele doc. `$changeStreamSplitLargeEvent` **não** resolve em definitivo: ele só quebra na granularidade de **campo de topo** e **falha** se um único campo (o `fullDocument`) já passa de 16MB. Confirmado na doc oficial.

**Exigência do usuário:** a réplica precisa ser **idêntica** a produção e **nunca** pode quebrar por 16MB — sem exceção.

### 2. Collections sem campo de data não têm âncora pra TTL
O comando `ttl` precisa de um campo BSON `Date`. Hoje só dá pra derivar do `_id` quando ele é `ObjectId` (`--derive-from-id`). Pra `_id` custom (string/número) **não há data** → não dá pra aplicar TTL. O `__sync.ts` injetado hoje **não serve**: é `Date.now()` (um **número**, não `Date`) e é **reescrito** a cada sync.

## A lei que guia o desenho 1

O dado do documento tem que chegar no destino de algum jeito. Ou viaja **dentro do evento** (delta/doc → pode passar de 16MB), ou **não viaja** e é **buscado** (`find`). Não há terceira opção. Como a exigência é "nunca 16MB + idêntico", o dado **não** pode viajar no evento → **re-busca**. O documento armazenado é sempre ≤16MB, então um `find` por `_id` sempre cabe. (O dump **já** funciona assim — lê doc, grava doc — por isso nunca estoura.)

## Decisões (resolvidas)

- **Substituição, não flag:** a re-busca cobre todos os casos (inclusive eventos <16MB), então **substitui** o `updateLookup`. Sem modo legado.
- **Filtros:** continuam feature de 1ª classe. Aplicados **pós-busca** (re-busca o doc, casa o filtro nele): casa → grava; não casa → **remove** do destino. Mais correto que hoje (doc que sai do filtro some do destino). Origem dos filtros: hoje não usados em prod, mas a capacidade permanece.
- **`__migratedAt`:** campo na **raiz**, BSON `Date`, semântica "quando entrou na réplica", **imutável** (gravado na 1ª escrita, dump ou watch-insert; nunca atualizado).
- **`__sync` inalterado** (`hot`/`ts`/`hash`): não muda semântica; só **adiciona** `__migratedAt`.

## Comportamento — desenho 1 (watch como gatilho + re-busca em lote)

### Pipeline (`core/sync/dbWatchPipeline.ts`)
- Abre `db.watch` **sem `updateLookup`**.
- `$project: { fullDocument: 0, updateDescription: 0 }` → o evento fica só com `_id` (resume token), `operationType`, `documentKey._id`, `ns`, `clusterTime`. **Sempre uns KB — impossível estourar 16MB.**
- O `$match` casa só por `ns.coll` (uma cláusula por collection; delete sempre passa). O **filtro sai do `$match`** (vai pro pós-busca), pois sem `fullDocument` não dá pra casar filtro no update.

> Crítico: tem que ser `updateLookup` **desligado** na abertura do stream — não basta `$project`. Com `updateLookup` ligado, o servidor **monta** o evento com o `fullDocument` gigante **antes** do `$project` e estoura na serialização ali.

### Buffer de mudanças (`core/sync/changeBuffer.ts`, novo)
Unidade isolada e testável.
- Acumula eventos `{ coll: string, id: unknown, op: "upsert" | "delete" }` (insert/update/replace → `upsert`).
- **Dedupe por (coll, id)** — a última operação vence (um delete posterior suprime um upsert anterior e vice-versa).
- Sinaliza **flush** quando atinge `batchSize` eventos **ou** passa `flushIntervalMs` desde o 1º evento bufferizado (o que vier primeiro).
- Interface:
  - `add(coll, id, op): void`
  - `size(): number`
  - `drain(): Map<coll, { upserts: id[]; deletes: id[] }>` — esvazia e devolve agrupado por collection.

### Flush (`core/sync/engine.ts`)
Por collection do `drain()`:
- **deletes** → `destCol.deleteMany({ _id: { $in: ids } })`.
- **upserts** → `srcCol.find({ _id: { $in: ids } }).toArray()`:
  - pra cada doc retornado: se passa no **filtro** da collection → `writeDocToDest` (ver abaixo); se **não** passa → `destCol.deleteOne({ _id })`.
  - `_id` que o `find` **não** retornou (deletado entre o evento e o fetch) → `destCol.deleteOne({ _id })`.
- Throttle por `parallel` (mesmo Bottleneck do dump) entre collections.

### Função de escrita unificada (`core/sync/writeDoc.ts`, novo — extraída do `dumpEvent.ts`)
Usada **pelo dump e pelo flush** (o watch vira "dump incremental"):
- `writeDocToDest(destCol, sourceDoc, origin): Promise<"written" | "skipped">`
- Calcula o hash do `sourceDoc`. Lê `__sync.hot`/`__sync.hash` do destino: `hot === true` → skip; hash igual → skip (zero-write idempotente).
- Senão, grava com **semântica de replace + `__migratedAt` imutável**, num único update atômico (sem leitura extra), via pipeline:
  ```
  destCol.updateOne(
    { _id },
    [{ $replaceWith: { $mergeObjects: [
        { $literal: <sourceDoc + __sync{hot,ts,hash} + origin> },
        { __migratedAt: { $ifNull: ["$__migratedAt", "$$NOW"] } }
    ] } }],
    { upsert: true }
  )
  ```
  - `$replaceWith` → destino vira cópia exata da origem (campos removidos na origem somem no destino — réplica idêntica).
  - `{ $literal: ... }` → embrulha o doc da origem pra valores como `"$x"`/`"R$ 5"` não serem interpretados como expressão.
  - `$ifNull: ["$__migratedAt", "$$NOW"]` → preserva o `__migratedAt` existente ou grava `$$NOW` (BSON `Date`) na 1ª vez. **Nunca atualiza.**
- Flush usa `bulkWrite` desses updates por collection (1 round-trip por lote, igual ao dump).

### Checkpoint / resume token (`core/sync/resumeCheckpointer.ts` + `engine.ts`)
- O token só avança pro **último evento de um lote já aplicado** (`lastFlushedToken`), **não** pro `stream.resumeToken` (que fica à frente do que foi escrito, pois o stream lê adiante pra encher o buffer).
- `ResumeTokenCheckpointer` passa a ler `lastFlushedToken` (setado no fim de cada flush) em vez de `stream.resumeToken`.
- Restart reprocessa do último flush — idempotente pelo hash-skip. `kill -9` perde no máx. ~1 lote (re-aplicado idempotente).

### Backpressure / memória
O `pump` (`for await`) alimenta o buffer; quando o buffer sinaliza flush, o `pump` **aguarda** o flush antes de puxar mais eventos. Memória presa a ~1 lote: N `_id`s minúsculos no buffer + N docs (≤16MB) durante o `find`/`bulkWrite` — **igual ao dump**.

### Race durante o dump inicial
Mantida: o `writeDocToDest` marca `__sync.hot: true`; o cursor do dump pula docs `hot` (já cobertos pelo watch). Sem mudança nessa lógica.

### Config
- `flushIntervalMs` — novo, default **1000ms**, via env `PULSAR_FLUSH_INTERVAL_MS` e/ou `performance.flushIntervalMs` no yml.
- `batchSize` — reusa o existente (tamanho do flush).

## Comportamento — desenho 2 (`__migratedAt`)
Sai de graça do `writeDocToDest` acima (o `$ifNull/$$NOW`). Sem comando novo: o TTL aponta pro campo:
```sh
pulsar ttl --uri ... --db ... --all --field __migratedAt --expire 30d
```
Cobre **toda** collection, independente do tipo de `_id` (resolve o gap do `--derive-from-id`, que só serve a `ObjectId`).

## O que NÃO muda
- O **dump inicial** (cursor `find`): segue igual; só passa a chamar `writeDocToDest` (que agora grava `__migratedAt`). Imune a 16MB como sempre foi.
- O comando `ttl`: nenhuma mudança de código — só ganha um campo pra apontar.
- `migrate` (mongodump/restore): fora de escopo.

## Erros / garantias
- Best-effort **por-doc**: uma escrita que falha loga e não derruba o lote.
- Deletes offline propagam: o oplog reentrega o trigger no resume → re-busca/delete.
- Nenhum ponto trafega >16MB: evento é só `_id`; doc vem por `find` (≤16MB sempre).
- Réplica idêntica: `$replaceWith` grava o doc exato da origem; `__migratedAt` é o único acréscimo, imutável.

## Testes (contra Mongo real, nomes genéricos)
- **changeBuffer** (puro): add/dedupe (upsert+upsert→1; upsert depois delete→delete; delete depois upsert→upsert), flush por tamanho, flush por tempo, drain agrupa por collection.
- **writeDoc** (Mongo real): grava doc + `__migratedAt` `Date` na 1ª vez; 2ª escrita **preserva** `__migratedAt` (mesmo valor); `$replaceWith` remove campo que sumiu da origem; hash igual → skip; `hot` → skip; valor com `"$..."` é gravado literal (não vira expressão).
- **engine — watch re-busca**: evento entrega só `_id` (sem fullDocument); update grande (doc perto de 16MB) **não** quebra e o doc chega no destino; dedupe gera 1 escrita; delete propaga; doc deletado entre evento e fetch → delete; filtro pós-busca (entra→grava, sai→remove do destino); checkpoint só avança no flush; restart reprocessa idempotente.
- **regressão:** os 40 testes existentes do engine verdes (comportamento do dump/resume/fallback 286/volumetria preservado).

## Fora de escopo (YAGNI)
- `$changeStreamSplitLargeEvent` (a re-busca já garante; não precisa).
- Aplicar delta (updateDescription) — descartado de propósito (reintroduz risco de 16MB e de divergência).
- Mudar `migrate` ou o comando `ttl`.
- Registrar valores intermediários de updates rápidos no mesmo lote (réplica = estado atual; convergência basta).
