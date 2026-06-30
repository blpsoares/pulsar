# Arquitetura do `sync` — visão completa

> Documento de referência da arquitetura do modo `sync` (watch contínuo).
> Para o desenho visual, abra `docs/arquitetura-sync.excalidraw` em
> [excalidraw.com](https://excalidraw.com).

O `sync` mantém um banco de **destino** (réplica) em dia com um banco de
**origem** (produção), em duas frentes que rodam **juntas no mesmo processo**:

1. **Dump inicial** — copia o que já existe (uma vez por collection).
2. **Watch contínuo** — replica cada mudança nova em tempo real.

O watch é **ligado ANTES** do dump começar — assim, enquanto a cópia varre as
páginas velhas, as mudanças novas já estão sendo capturadas e nada cai no vão.

Regra dura: **a origem é só lida; toda escrita acontece no destino.**

---

## 1. Conexões com o Atlas

- **1 conexão de escuta** (um único `db.watch` no banco inteiro).
- **~`parallel` conexões** que giram para os dumps (default 3–5).

Por quê 1 só de escuta: cada change stream é um *long-poll* que prende uma
conexão para sempre. Um stream por collection (ex.: 50) prenderia 50 conexões +
as de dump → estoura o limite do Atlas compartilhado. Logo: **um stream só**,
recortado nas N collections via `$match` em `ns.coll`.

Código: `core/sync/engine.ts` (`openStream`), `core/sync/dbWatchPipeline.ts`.

---

## 2. Metade 1 — o dump inicial

Para cada collection, em paralelo (limitado por `parallel`):

1. Abre um **cursor** na origem por `_id` **decrescente** (`find().sort({_id:-1})`).
2. Lê em lotes (`batchSize`, default 500). Para cada doc, decide olhando o **destino**:
   - não existe → **insert**
   - existe e **hash igual** → **skip** (zero escrita)
   - existe e **hash diferente** → **update**
   - existe e `__sync.hot === true` → **skip** (a versão ao vivo do watch vence)
3. A cada lote, grava a **fronteira** (`dumpCursorId` = menor `_id` já processado)
   no `__sync` do destino, ~a cada 5s.
4. Ao terminar **de verdade** → carimba `dumpCompletedAt` e **apaga** a fronteira.

O re-dump é **idempotente**: insere o que falta, pula o que já está igual.

Código: `core/sync/dumpEvent.ts` (`dumpCollections`, `processBatch`),
`core/sync/writeDoc.ts`, `core/sync/syncState.ts` (`saveDumpProgress`,
`markDumpCompleted`).

### 2.1 Guarda de reconciliação (anti-truncamento)

Um cursor de vida longa contra um Atlas remoto/compartilhado pode **encerrar
cedo SEM lançar erro** (nó caiu/failover, cursor morto → o driver às vezes
termina o `for await` como se fosse fim natural). O código antigo tratava
"o loop terminou" como "li tudo" e carimbava `dumpCompletedAt` com cópia parcial
— **perda silenciosa de dados**.

A guarda: antes de marcar completo, conta `countDocuments({_id: {$lt: fronteira}})`.
Se sobra algo abaixo da fronteira, a varredura **não** terminou → reabre da
fronteira (ou, esgotados os retries, falha alto e a collection entra em
`failedDumps` para re-dumpar no próximo restart). **Nunca** marca parcial como
completo. Como o check usa `_id < fronteira`, inserts ao vivo (que têm `_id`
maior) não geram falso positivo.

Código: `core/sync/dumpEvent.ts` (bloco "GUARDA DE RECONCILIAÇÃO").
Testes: `test/dumpReconcile.test.ts`.

---

## 3. Metade 2 — o watch contínuo

1. **Um** `db.watch` no banco, recortado nas N collections.
2. O evento é só um **gatilho**: o stream é aberto **sem o documento**
   (sem `updateLookup`, com `$project` removendo o `fullDocument`). Só importam
   `ns.coll` e `_id`. → **Imune ao limite de 16MB** do change stream: o evento
   nunca carrega o doc, só o `_id` de ~12 bytes.
3. Os `_id`s caem num **`ChangeBuffer`**, deduplicados por collection.
4. A cada `flushIntervalMs` (~1s), o **`flush`** drena o buffer e **re-busca** os
   docs na origem (`find({_id: {$in: [...]}})`) e escreve no destino. Doc ausente
   na re-busca = deleção → `deleteOne`.
5. **Backpressure**: consome o stream com `for await`, **aguardando** cada escrita
   antes de puxar o próximo evento. Memória presa a ~1 lote (matou um OOM antigo
   do antigo `.on('change')` fire-and-forget).

Código: `core/sync/engine.ts` (`pump`, `flush`), `core/sync/changeBuffer.ts`,
`core/sync/writeDoc.ts` (`writeDocToDest`).

---

## 4. O resume token

- Todo change stream entrega, a cada evento (e mesmo parado, via *post-batch
  resume token*), um **resume token**: um marca-página **opaco no oplog** do
  Mongo — "já processei até aqui".
- Como o stream é **um só** (banco inteiro), existe **UM token global**, salvo
  no destino em `__sync`, doc `id: "__pulsar_db__"`, campo `resumeToken`.
  Atualizado ~a cada 5s pelo `ResumeTokenCheckpointer`.
- **Crítico:** salva o token do **último lote já ESCRITO** (`lastFlushedToken`),
  não o do último evento visto → o token só avança quando a escrita está
  garantida. Um `kill -9` perde no máximo ~5s, re-aplicados idempotente.
- **Retomada:** no restart, reabre `db.watch` com **`startAfter: <token>`**. O
  oplog **reentrega** tudo que mudou offline (insert/update/**delete**) em
  segundos — sem re-escanear.
- **Falha (286):** se o token for velho demais (oplog girou → `286
  ChangeStreamHistoryLost`), não dá para retomar → **`forceDumpAll`**: re-dumpa
  tudo. É o tradeoff de um token único global.

Código: `core/sync/resumeCheckpointer.ts`, `core/sync/syncState.ts`
(`loadDbResumeToken`, `saveDbResumeToken`), `core/sync/restartDecision.ts`
(`isHistoryLostError`).

---

## 5. Os DOIS marca-páginas (não confundir)

| | O que marca | Onde mora | Escopo |
|---|---|---|---|
| **`dumpCursorId`** | até onde a **xerox inicial** chegou | `__sync`, doc da collection | **por collection** |
| **`resumeToken`** | até onde o **watch ao vivo** chegou no oplog | `__sync`, doc `__pulsar_db__` | **global (1 só)** |

O primeiro retoma um **dump incompleto**. O segundo retoma o **tempo real** sem
re-escanear. São independentes.

---

## 6. Decisão no restart (por collection)

`decideStartupAction` (`core/sync/restartDecision.ts`):

- **RETOMA** (pula o dump) se: já tinha `dumpCompletedAt` **e** existe token global
  → reabre o watch pelo token; o oplog cobre o que mudou offline.
- **RE-DUMPA** se: nunca concluiu, não há token, ou `--full`.
- Se o token global expirou (286) → `forceDumpAll` força dump de **todas**.

---

## 7. Onde o estado mora

Dois lugares, propósitos diferentes:

**(A) A collection `__sync`** = estado de **orquestração**.
- 1 doc por collection: `{ id, dumpCompletedAt, dumpCursorId, dumpProgressAt }`
- 1 doc global: `{ id: "__pulsar_db__", resumeToken, tokenUpdatedAt }`

**(B) O `__sync` EMBUTIDO em cada doc replicado** = metadado **por documento**:
`{ __sync: { hot, ts, hash }, origin, __migratedAt }`.
- `hash` — decide skip/update no re-dump (doc idêntico → não reescreve).
- `hot` — proteção da corrida: o watch tocou no doc durante o dump → não
  sobrescrever com a versão velha.
- `origin` — informativo (`dump | watch:insert | ...`).
- `__migratedAt` — âncora de TTL (quando o doc entrou na réplica; imutável).

Discussão de design: centralizar (B) numa collection à parte **não** compensa
(dobraria o storage com um índice `_id → hash` do tamanho da origem + um lookup
por doc). O que faz sentido mesmo em (B) é `hot` e `__migratedAt`; `hash` e
`origin` são candidatos a remover se quiser docs mais limpos (ao custo de
re-dump escrever mais). (A) está correto onde está.

---

## 8. Views e índices (fora do caminho do sync)

- **Índices** (`copyIndexes: true`): diff por assinatura origem×destino, cria só
  os que faltam. Quem dumpa cria depois do dump; quem resume cria no startup.
  Código: `core/sync/copyIndexes.ts`.
- **Views** (`copyViews: true | [nomes]`): views são **metadado** (`viewOn` +
  `pipeline`), não dados. Rodam **em paralelo** ao dump (não dependem de dado; o
  Mongo cria view até sobre collection inexistente). Igual → pula; diferente →
  salva a antiga em `<name>__pulsar_bkp` e recria idêntica à origem; ausente →
  cria. **Só escreve no destino.** Código: `core/sync/copyViews.ts`.

Ambos são **contidos**: falha de um índice/view loga e segue, não derruba o sync,
e é re-tentada no próximo startup.

---

## 9. Guardrails (resumo)

1. **Guarda de reconciliação** — não marca dump completo sem conferir a fronteira.
2. **Retry transitório** — erro de rede no dump → backoff e retoma da fronteira.
3. **Backpressure** — espera a escrita antes do próximo evento (anti-OOM).
4. **Corrida (`hot`)** — versão ao vivo vence a versão velha do dump.
5. **Token só avança após escrita** (`lastFlushedToken`).
6. **Shutdown gracioso** — SIGINT/SIGTERM fazem flush do token + fronteiras.
7. **1 stream só** — não satura o Atlas.
8. **Detector do 286** — token expirado → re-dumpa em vez de fingir retomada.
9. **Prod read-only** — toda escrita só no destino.
10. **copyViews/copyIndexes contidos** — falha de um não derruba o sync.

---

## 10. Exemplo ponta a ponta

Cenário: origem com a collection `pedidos` (117 docs) e uma view `pedidos_ativos`
(`viewOn: pedidos`). Destino vazio. `copyIndexes: true`, `copyViews: true`.

### Boot 1 — banco do zero

1. **Carrega token** do `__sync` do destino → não existe (banco novo).
2. **Abre o `db.watch`** fresh (sem `startAfter`). A partir daqui, toda mudança
   na origem já é capturada no `ChangeBuffer`.
3. **Liga o checkpointer** (salva o token a cada ~5s) e dispara o **`copyViews`
   em paralelo**: cria a view `pedidos_ativos` no destino.
4. **Decide por collection:** `pedidos` não tem `dumpCompletedAt` → **DUMP**.
5. **Dump de `pedidos`:** cursor `_id:-1`, lotes de 500.
   - Para cada doc: não existe no destino → **insert** (com `__sync.hash`,
     `origin: dump`, `__migratedAt`).
   - A cada lote: grava `dumpCursorId` no `__sync`.
   - **Guarda:** ao fim do cursor, `countDocuments({_id < fronteira}) == 0` →
     varredura completa → segue.
6. **Carimba `dumpCompletedAt`** de `pedidos` e **apaga a fronteira**.
7. **Cria os índices** de `pedidos` (build em lote, pós-dump).
8. **Semeia o token global** com a posição atual do stream e faz o checkpoint.
9. Resultado: destino com 117 docs, view `pedidos_ativos` resolvendo, índices no lugar.
   O processo agora vive no **watch**.

### Em produção — uma mudança ao vivo

1. Alguém atualiza um doc de `pedidos` na origem.
2. O `db.watch` emite um **gatilho** (só `ns.coll` + `_id`, sem o doc).
3. O `_id` entra no `ChangeBuffer`.
4. No próximo `flush` (~1s): re-busca o doc na origem (`find({_id: {$in:[id]}})`)
   e faz `update` no destino, marcando `__sync.hot` e preservando `__migratedAt`.
5. O `lastFlushedToken` avança; ~5s depois o checkpointer persiste o token.

### Boot 2 — restart após 10 min offline

1. **Carrega token** → existe.
2. **Abre o `db.watch` com `startAfter: token`** → o oplog **reentrega** os 10 min
   de mudanças (inserts/updates/**deletes**) em segundos.
3. **Decide por collection:** `pedidos` tem `dumpCompletedAt` + token →
   **RETOMA** (pula o dump). `copyViews`/`copyIndexes` rodam e acham tudo igual →
   pulam.
4. Em segundos a réplica está em dia, **sem re-escanear** 117 docs.

### Caso de falha — cursor truncou no dump (boot do zero)

1. No dump de uma collection grande, o cursor **encerra cedo** (failover do Atlas)
   sem lançar erro, na fronteira `_id = X`.
2. **Guarda:** `countDocuments({_id < X})` retorna > 0 → **não** está completo.
3. Reabre o cursor de `_id < X` e continua. (Se esgotar os retries, falha alto →
   `failedDumps` → re-dumpa no próximo restart.)
4. `dumpCompletedAt` **só** é carimbado quando a guarda vê 0 docs abaixo da
   fronteira. Nunca marca parcial como completo.

### Caso de falha — token expirado (286)

1. Restart após muito tempo offline; o oplog já girou e jogou fora a posição.
2. `db.watch` com `startAfter` falha com `286 ChangeStreamHistoryLost`.
3. `forceDumpAll`: todas as collections voltam ao caminho de **dump** (re-sincroniza
   tudo), porque a posição global foi perdida.
