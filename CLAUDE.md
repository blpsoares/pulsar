# Mongo Pulsar — CLAUDE.md

CLI em Bun/TypeScript para sincronização de dados entre bancos MongoDB. Dois modos: `migrate` (snapshot via mongodump/mongorestore) e `sync` (watch contínuo via Change Streams).

## Stack

- **Runtime:** Bun
- **Linguagem:** TypeScript
- **Driver:** mongodb v6
- **CLI:** commander
- **Rate limiting:** bottleneck (controla paralelismo de operações Mongo)
- **Progress bar:** cli-progress
- **Logs arquivo:** winston
- **Linter:** Biome

## Comandos úteis

```sh
bun run bin:dev        # compila e instala o binário em ~/.local/bin/pulsar
bun run bin:prod       # compila para dist/pulsar sem instalar
bun run sys:info       # mostra CPU/RAM/swap/disco, explica cada limite e sugere valores pro compose-limit
bun run sys:info --apply  # idem + GRAVA os valores recomendados no docker-compose-limit.yml
bun run compose:up     # atalho interativo: cria uma 2ª+ instância pulsar-sync ao lado das existentes (recursos recomendados pelo uso)
pulsar compose up      # idem, via binário instalado (bin:dev)
bun run get:cli        # compila e instala o comando em ~/.local/bin (avisa se estiver fora do PATH)
bun run rec:tui        # regrava os GIFs da TUI em docs/media (precisa de vhs+ttyd+ffmpeg)
pulsar                 # sem argumento: abre a TUI (Ink)
pulsar start           # caminho guiado na CLI: escolhe/cria config → aqui ou background → supervisor
pulsar tui             # abre a TUI (Ink) — cria config, roda, instala serviço, lê log
bun run src/cli.ts migrate configs/test.yml -p 4
bun run src/cli.ts sync configs/test.yml
bun run src/cli.ts sync configs/test.yml --verbose
bun run src/cli.ts verify configs/test.yml --deep     # confere se o destino tem o que a origem tem
bun run src/cli.ts ttl configs/ttl-example.yml                                       # TTL em massa via yml
bun run src/cli.ts ttl --uri '...' --db x --all --derive-from-id --expire 30d        # TTL em massa via CLI
```

## Estrutura

```
src/
  cli.ts                  # entrypoint, define os comandos CLI
  commands/
    start.ts              # `pulsar start`: fluxo guiado na CLI (config → aqui/background → supervisor)
    migrate.ts            # orquestra o fluxo completo de dump/restore
    sync.ts               # orquestra o fluxo de watch; inicializa logConfig
    ttl.ts                # comando standalone: cria índices TTL em massa (yml ou CLI)
    verify.ts             # comando standalone: audita origem x destino (--deep/--reconcile), exit 1 se divergir
    compose.ts            # comando interativo `compose up`: gera docker-compose-limit-<N>.yml de uma nova instância
  core/
    dump/
      dump.ts             # exporta collections via mongodump (com resume se temp-dump existir)
      restoreDump.ts      # restaura via mongorestore com prefixo _dump_
      initSync.ts         # registra estado inicial na collection __sync do destino
      dropOldCollections.ts
      renameCollections.ts
    sync/
      engine.ts           # SyncEngine: UM db.watch p/ todas as colls (roteia por ns.coll) + restart incremental
      dbWatchPipeline.ts  # monta o $match do db.watch recortado nas X collections (+ filtros)
      restartDecision.ts  # decide resume|dump + detector do erro 286 (oplog estourado)
      syncState.ts        # __sync do destino: dumpCompletedAt/dumpCursorId por coll + resumeToken GLOBAL do db.watch
      resumeCheckpointer.ts # persiste o resume token (PBRT) a cada ~5s
      index.ts            # só exporta acceptableEventOperations (orquestração migrou pro engine)
      dumpEvent.ts        # cursor completo com hash comparison, progress bar e stats
      watcherEvents.ts    # EventEmitter central para eventos do change stream
      changeBuffer.ts     # ChangeBuffer: dedupe/drain de IDs por collection para flush em lote
      deleteEvent.ts      # loga [collection] delete | _id quando verbose
      copyViews.ts        # recria views da origem no destino (copyViews): paralelo ao dump, idempotente
    verify/
      verifyCollection.ts   # compara origem x destino (count ou deep por _id) e recopia faltantes
    ttl/
      parseDuration.ts      # "30d"/"1h"/"3mo" -> segundos (mês=30d, ano=365d; 'm' proibido)
      resolveTtlEntry.ts    # precedência defaults+override por collection; erro se não resolve
      deriveCreated.ts      # updateMany pipeline { $toDate: "$_id" } -> campo _created (idempotente)
      applyTtl.ts           # materializa (se preciso) + createIndex TTL por collection
    compose/
      recommend.ts          # recomenda recursos: orçamento (~65% RAM, ~1 core livre) MENOS o já comprometido pelas instâncias existentes
      buildCompose.ts       # gera o compose da nova instância a partir do docker-compose-limit.yml base (troca nome/config/volumes/recursos)
      detectConfigs.ts      # varre *.yml e classifica por command.sync/migrate/ttl (mostra destino)
      committed.ts          # soma mem/cpu já comprometidos pelos containers pulsar-sync (usado pelo compose up e pela TUI)
    inspect/                # [TUI] introspecção: collections+views, $collStats, índices, probe de conexão, maskUri
    config/                 # [TUI] form <-> yml: formState, buildConfig, loadConfig, writeConfig (valida com Zod)
    run/                    # [TUI] pulsarCommand (binário vs bun src/cli.ts), logLines (ANSI/ring buffer)
    service/                # [TUI] background: systemd, launchd, pm2, docker + detect/discover/manager
                            #   privileged (sudo na hora), oneshot (desliga boot), enableBoot (religa),
                            #   switchBackend (troca com rollback), fromRecord (registro -> ServiceSpec)
    state/                  # [TUI] registry (~/.pulsar/services/*.json), runRecord (lastRun gravado pelo
                            #   próprio processo), reconcile (registro × supervisor), adopt (reconstrói registro)
    tty/                    # ansi (sequências) + handoff (empresta o terminal ao sudo e retoma em finally)
    logs/                   # [TUI] readLog (tail pela cauda), tailCommand (journalctl/pm2/docker/tail)
  tui/
    index.tsx             # render da TUI; exige TTY (sem TTY manda usar os subcomandos)
    App.tsx               # tela raiz + PILHA de camadas (detail/form/logs/switch/runner/help)
    keys.ts               # fonte única das teclas por camada (barra = filtro; `?` = tudo, agrupado)
    layout.ts             # geometria pura: layout(), overlayBox(), listWindow()
    theme.ts              # paleta/glifos
    components/           # Shell, Overlay, HelpOverlay, SudoConfirm, Select, TextInput,
                          #   CollectionPicker, EntryPicker, SearchField
                          #   + form/ (pickers de collections/views/índices, usados pelo ServiceForm)
    mouse/                # MouseProvider (hit-testing + useClickable) e parse (SGR 1006)
    hooks/                # useInspector (Mongo), useProcess (filho), useSpinner, useTerminalSize
    screens/              # ServicesPanel (raiz), ServiceDetail, ServiceForm (+ serviceFormFields:
                          #   campos por modo, regras puras), LogViewer, Runner
  stubs/
    react-devtools-core.ts  # stub p/ o ink sobreviver ao bun build --compile
  functions/
    getCollections.ts     # resolve lista de collections; carrega filter/filterFile
    freeze.ts             # chamado no início do sync (operação no destino)
  utils/
    idKey.ts              # chave canônica de _id (BSON) — NUNCA String(id): colide em _id composto
    mongo.ts              # addFieldsOnMongoDocument + hash SHA-1 + transformFilterForChangeStream
    logConfig.ts          # singleton { verbose, progress } — setado em sync.ts, lido nos handlers
    parseYml.ts           # valida yml via Zod
    customLog.ts          # logger terminal (chalk) + arquivo (winston)
    createProgressBar.ts  # helper cli-progress (usado no migrate; sync cria a barra direto)
  types/
    parseYml.ts           # schemas Zod e tipos exportados (SyncCollectionEntry, etc.)
    cliOptions.d.ts       # MigrateOptionsCli, SyncOptionsCli
```

## Comportamento crítico do sync

### Stream único (`db.watch`) — 1 conexão pra todas as collections

**Crítico p/ não saturar o Atlas.** O `sync` abre **UM único change stream no banco** (`sourceDb.watch`), recortado nas X collections via `$match` em `ns.coll` (`dbWatchPipeline.ts`), e **roteia cada evento pela `ns.coll`** pra collection de destino. Antes era 1 `collection.watch()` por collection → 55 conexões presas (cada change stream é um long-poll que prende 1 conexão pra vida toda) → 400-950 conexões no Atlas, derrubando o cluster compartilhado. Agora: **1 conexão de escuta** + ~`parallel` conexões de dump que giram. Por isso `maxPoolSize` é baixo (30) em `db/conn.ts`.

**Watch como gatilho — re-busca em lote (`changeBuffer.ts` + `engine.ts` `flush`)**: o change stream é aberto **sem `updateLookup`** e com um `$project` que retira o `fullDocument` — o evento é usado apenas como **gatilho** (só `ns.coll` e `_id` importam). Os `_id`s recebidos são acumulados por collection no `ChangeBuffer` (dedupe por `_id`, sem duplicatas por evento rápido no mesmo doc). A cada `flushIntervalMs` (default 1000ms, configurável via `PULSAR_FLUSH_INTERVAL_MS` ou `performance.flushIntervalMs` no yml), o `flush()` drena o buffer e re-busca os docs via `find({ _id: { $in: [...] } })` na origem, escrevendo no destino via `writeDocToDest`. Docs ausentes na re-busca (deleções) recebem `deleteOne` no destino. Isso torna o watch **imune ao limite de 16MB** do change stream (o evento jamais carrega o documento — qualquer doc, de qualquer tamanho, passa como `_id` de ~12 bytes). O checkpoint após cada flush carimba o `lastFlushedToken` (não o `stream.resumeToken` instantâneo), garantindo que o token só avança quando todos os `_id`s daquele lote foram escritos. Lógica em `core/sync/changeBuffer.ts` e `engine.ts` (`flush`).

**Consumo com backpressure (`engine.ts` `pump`)**: o stream é consumido via `for await`, **aguardando** cada escrita no destino antes de puxar o próximo evento. Isso prende a memória a ~1 lote do change stream e aplica os eventos **em ordem**. Substituiu o antigo `.on('change')` fire-and-forget, que disparava escritas concorrentes ILIMITADAS — no replay de um backlog grande (resume após downtime) isso empilhava milhares de `updateOne` + fullDocuments em memória e estourava a RAM da VM (era a causa raiz do OOM). O probe do resume (detecção do token válido vs 286) é por **polling do `resumeToken`** enquanto o `pump` dirige o stream — não bloqueia, mantém o resume rápido.

### Restart incremental — resume token (`core/sync/engine.ts`)

No restart, **cada collection decide entre RETOMAR ou re-DUMPAR**:

- **Retoma** (pula o dump) quando o dump anterior concluiu (`dumpCompletedAt`) **e** há um resume token global salvo. O `db.watch` reabre com `startAfter: token` → o oplog reentrega tudo que mudou offline (insert/update/**delete**), em segundos, **sem re-escanear**.
- **Re-dumpa** quando: nunca terminou o dump, não há token, ou `--full`. Se o **token global** expirar (oplog estourado → `286 ChangeStreamHistoryLost`), o stream único cai em **forceDumpAll** → re-dumpa **todas** (perdeu-se a posição de todas de uma vez — é o tradeoff do token único).

Estado no `__sync` do destino: 1 doc por collection `{ id, dumpCompletedAt, dumpCursorId }` + 1 doc global `{ id: "__pulsar_db__", resumeToken, tokenUpdatedAt }`.

- `dumpCompletedAt` é carimbado **só quando o dump conclui de fato** (`dumpCollections` retorna `true`).
- `resumeToken` é o PBRT do `db.watch` (**um só, global**), persistido a cada ~5s pelo `ResumeTokenCheckpointer`. Um `kill -9` perde no máximo ~5s; SIGINT/SIGTERM fazem flush final antes de sair.
- `--full` (`-f`) ignora os carimbos e força dump completo de tudo (reconciliação total).

**Dump retomável (`dumpCursorId`):** se um dump **não termina** (interrompido, timeout de conexão), o cursor (que varre `_id:-1`) carimba a fronteira — o menor `_id` já processado — no `__sync` a cada ~5s (`saveDumpProgress`). No restart, um dump incompleto **continua de `find({ _id: { $lt: dumpCursorId } })`** em vez de recomeçar do zero. `markDumpCompleted` limpa a fronteira ao concluir; `--full` a ignora. Limitação: mudanças offline na faixa **já dumpada** (`_id ≥ fronteira`) não são reconciliadas nesse caminho (stream reabre fresh, não por token) — só um `--full` cobre.

**Retry do dump dentro do run (`dumpEvent.ts`):** além da retomada entre restarts, uma falha **transitória** de conexão no meio do dump (ECONNREFUSED, reset, failover de nó do Atlas, cursor morto no getMore) **não aborta** a collection. O cursor reabre **da fronteira viva** (a mesma `_id` que vinha sendo carimbada, sem re-escanear) com backoff exponencial (`DUMP_RETRY_BASE_MS` → cap 30s), até `DUMP_MAX_RETRIES` tentativas (default 30 ≈ 14min). Crítico p/ collections enormes (215M) rodando sem supervisão: sem isso, um blip às 3h da manhã abortava o dump e ele só retomava num restart manual. Erro **lógico** (não-transitório) não é retentado. Esgotados os retries, a collection entra em `SyncEngine.failedDumps` (sem `dumpCompletedAt` → re-dumpa da fronteira no próximo restart) e o `sync.ts` loga um relatório honesto ("N FALHARAM e serão retomadas") em vez de "concluído em 54".

Decisão e detector do 286 vivem em `core/sync/restartDecision.ts`. Testado em `test/` (40 testes contra Mongo real: cold, restart offline, fallback 286, race, `--full`, volumetria ~25× mais rápido, dump retomável por fronteira, e stream único roteando várias collections / token global). Rodar: `bun test` (precisa dos containers: `bun run test:up`). Desenho completo em `docs/superpowers/specs/2026-06-18-sync-resume-token-design.md`.

### `_id` não-escalar — chave canônica (`utils/idKey.ts`)

**Nunca use `String(id)` / `id.toString()` como chave de `_id` em memória.** Todo `_id` composto (`{chave, target}`) vira `"[object Object]"`, e o número `5` e a string `"5"` viram ambos `"5"`. Use `idKey(id)` (`BSON.serialize` em base64: carrega o tipo e preserva a ordem das chaves — a mesma semântica de igualdade de `_id` do Mongo).

Essa colisão foi a causa de perda silenciosa de dados em produção (`_m_snapshotDados`: 3.199.407 na origem, 841.008 no destino, marcada como concluída):

- **`dumpEvent.processBatch`** filtrava com `deletedIds.includes(d._id.toString())`. Bastava **um** delete chegar pelo watch durante o dump inicial para que, dali em diante, **todo** doc de `_id` composto casasse com `"[object Object]"` e fosse descartado. O dump seguia avançando a fronteira, a guarda de reconciliação (que confere a origem *abaixo da fronteira*) passava, e a collection era carimbada com `dumpCompletedAt`.
- **`ChangeBuffer.add`** dedupava por `String(id)` → todos os `_id` compostos de uma collection colapsavam numa entrada; o watch aplicava 1 doc por collection por flush.
- **`engine.flush`** comparava `found`/`missing` por `String(_id)` → doc vivo na origem podia ser classificado como ausente e **apagado** do destino via `deleteMany`.

Testes: `test/idKey.test.ts`, `test/idKeyCollision.test.ts`, `test/engine.compositeId.test.ts` (3 dos 4 falham no código anterior).

### Checagem de integridade no startup (`integrityCheck`, default **true**)

`dumpCompletedAt` é bookkeeping, não medição. Antes disso, uma collection carimbada por engano **retomava para sempre**: o change stream só entrega mudança nova e nunca reinjeta doc pré-existente, então o buraco era permanente e invisível. Foi assim que 6,2M docs em 33 collections ficaram de fora enquanto o painel dizia `52/52 up to date` em 9s.

Agora, no startup, toda collection que **iria retomar** tem origem e destino contados (`countDocuments`, exato — `estimatedDocumentCount` é aproximado e aproximar aqui significa re-dumpar à toa ou deixar passar buraco real). Se o destino está **devendo**, o carimbo é ignorado e ela cai no dump.

- Um re-dump espúrio é seguro: é idempotente e pula doc idêntico por hash (`500 docs | 120 skipped | 380 inserted`).
- Destino com **mais** docs que a origem **não** dispara re-dump — isso é órfão (doc que sumiu da origem via `drop`, que o watch não propaga), outro problema.
- O filtro da collection entra na contagem da origem, senão collection filtrada acusaria déficit falso.
- Falha ao contar (blip de rede) **não** força re-dump — só loga.
- `integrityCheck: false` no yml volta ao comportamento antigo.

Testes em `test/engine.integrity.test.ts` (5 casos, incluindo o cenário real: run legítimo carimba, destino perde docs, restart detecta e fecha).

### Comando `verify` — auditoria de integridade

`dumpCompletedAt` é **bookkeeping, não medição**. Uma collection carimbada por engano retoma para sempre, e o change stream nunca reconcilia (só entrega mudança nova; jamais reinjeta doc pré-existente que ficou para trás). Por isso "up to date 52/52" no painel não é evidência de nada.

```sh
pulsar verify config.yml                      # compara totais (rápido)
pulsar verify config.yml --deep               # _id a _id: diz QUAIS docs faltam
pulsar verify config.yml --deep --reconcile   # recopia da origem os faltantes
pulsar verify config.yml --deep --json        # p/ cron/CI
```

Sai com **código 1** quando sobra déficit (após a reconciliação, se houver) — dá pra pendurar em cron. A comparação usa `idKey`, então funciona com `_id` composto. Lógica em `core/verify/verifyCollection.ts`, testes em `test/verifyCollection.test.ts`.

### Dump inicial (`core/sync/dumpEvent.ts`)

Ao iniciar/reiniciar o watch, cada collection passa por um cursor completo. Para cada documento:

1. Conta total via `countDocuments(filter)` — alimenta a barra de progresso
2. Para cada doc do cursor:
   - Busca `__sync.hot` e `__sync.hash` no destino (uma query leve)
   - `__sync.hot === true` → pula (change stream já atualizou com versão mais recente)
   - Hash igual → pula (doc idêntico, zero writes)
   - Hash diferente → `updateOne`
   - Doc ausente → `insertOne`
3. Ao finalizar: emite `finishDump` com stats `{ total, skipped, updated, inserted }`

Isso permite reiniciar o watch adicionando novas collections sem reprocessar docs já sincronizados.

### Race condition durante o dump

O Change Stream abre **antes** do dump iniciar. Se um doc for atualizado via Change Stream enquanto o cursor ainda não chegou nele:
- Change Stream atualiza o doc no destino e seta `__sync.hot: true`
- Quando o cursor chega nesse doc, `hot === true` → pula
- Doc no destino fica com a versão mais recente (do Change Stream)

### Filtros por collection

Definidos no yml como string simples, objeto com `filter` inline ou `filterFile`:

```yaml
collections:
  - users                        # sem filtro
  - name: orders
    filter:
      status: "active"
      value:
        $gt: 100
  - name: logs
    filterFile: ./filters/logs.json   # JSON com filtro complexo
```

O filtro é aplicado em:
- `find(filter)` no cursor do dump
- `watch([{ $match: transformado }])` no Change Stream (campos prefixados com `fullDocument.`)
- Deletes sempre passam, independente do filtro

### Campos adicionados nos docs do destino

```json
{
  "__sync": { "hot": true, "ts": <epoch_ms>, "hash": "<sha1>" },
  "origin": "dump | watch:insert | watch:update | watch:replace"
}
```

O hash é calculado do documento **original** (sem `__sync`/`origin`), então a comparação funciona mesmo com os metadados presentes no destino.

### `__migratedAt` — âncora de TTL

Toda escrita no destino (dump e watch) grava um campo `__migratedAt` na **raiz**, do tipo BSON `Date`, com a data em que o doc **entrou na réplica**. É **imutável**: gravado na 1ª escrita e preservado nas demais (via pipeline `$ifNull("$__migratedAt", "$$NOW")` em `core/sync/writeDoc.ts`). Serve de âncora pro comando `ttl` em collections cujo `_id` **não** é `ObjectId` (onde `--derive-from-id` não funciona):

```sh
pulsar ttl --uri '...' --db x --all --field __migratedAt --expire 30d
```

Não é a data de criação real em produção — é "quando sincronizou". Pra limpeza da réplica (expirar X tempo após entrar), é a âncora correta. Lógica em `core/sync/writeDoc.ts`, testes em `test/writeDoc.test.ts`.

### Cópia de índices (`copyIndexes`)

O copy doc-a-doc do sync **não** traz os índices secundários da origem (só os dados; `migrate` via mongorestore traz). Com `copyIndexes` no yml, o sync replica os índices da origem no destino: faz um **diff por assinatura** (key+opções) e cria **só os que faltam** — num banco já migrado, a maioria das collections nem recebe escrita.

Aceita `true` (todos) ou uma **lista por collection**, quando só alguns índices interessam na réplica (build de índice em collection de centenas de milhões de docs custa horas e disco):

```yaml
copyIndexes: true            # todos os secundários de todas as collections
# — ou —
copyIndexes:
  - collection: pedidos
    indexes: [cliente_1, data_-1_status_1]
```

A forma de **objeto** (e não `"pedidos.cliente_1"`) é proposital: nome de collection e nome de índice aceitam ponto, e um separador ambíguo tornaria `vendas.2024.status_1` indecifrável. Collection **não citada** na lista não recebe índice nenhum; lista vazia idem — quem escolheu um a um não quer o pulsar decidindo por ele. `_id_` nunca entra (já existe no destino). Collection que dumpa cria o índice **depois** do dump (build em lote, igual mongorestore); collection que resume completa no startup. Falha de `createIndex` (ex.: conflito de nome) é **contida** (loga, não aborta o sync) e re-tentada no próximo startup. Nunca remove índices que existem só no destino. Painel final mostra `Índices · criados/já existiam/falhados`. Lógica em `core/sync/copyIndexes.ts`, testes em `test/copyIndexes.test.ts` e `test/engine.copyIndexes.test.ts`.

### Migração de views (`copyViews`)

O sync replica **collections** (dump + change stream); **views NÃO são sincronizadas** — uma view é metadado puro (`viewOn` + `pipeline`), sem documentos, sem oplog. Então, ao dropar/recriar o destino do zero, as views da origem **somem e não voltam** sozinhas (o pulsar não as enxerga na lista de collections). `copyViews` resolve isso recriando as definições no destino:

```yaml
copyViews: true               # todas as views da origem
# — ou —
copyViews:
  - regioes                   # só estas (por NOME)
  - _v_snapshotDados
```

- **Roda em PARALELO ao dump**, fora do caminho de sync (views não dependem de dado; o Mongo cria view até sobre collection inexistente, então não há ordem a respeitar). Não bloqueia nem atrasa as collections.
- **Idempotente por diff** (viewOn+pipeline+collation): cria a que falta, `collMod` na que difere (**sem dropar**), pula a idêntica.
- **Seguro:** se o destino já tem uma **collection real** com o nome de uma view da origem, ela é **preservada** (a view entra em `falhas`, não sobrescreve dado). **Nunca remove** view que só existe no destino.
- Erro por-view é **contido** (loga `view:falha`, não aborta o sync) e re-tentado no próximo startup. Painel final: `Views · criadas/atualizadas/iguais/falhadas`.
- **Atenção:** uma view cujo `viewOn` **não** está na lista de `collections` sincronizadas existe mas retorna vazio — use o array pra escolher só as views cuja base é sincronizada. Default `false` (nenhuma).

Lógica em `core/sync/copyViews.ts`, testes em `test/copyViews.test.ts` e `test/engine.copyViews.test.ts`.

### Logging

Controlado pelo singleton `logConfig.ts`:

| Fonte | Prioridade |
|---|---|
| flag `--verbose` na CLI | Alta (sobrescreve yml) |
| `logging.verbose` no yml | Normal |
| padrão | `verbose: false`, `progress: true` |

- **`progress: true`** — barra de progresso por collection durante o dump
- **`verbose: true`** — loga cada evento (insert/update/delete/replace) no terminal
- Winston sempre escreve tudo em `logs/debug.log` e `logs/error.log`, independente de verbose

## Formato dos YMLs

```yaml
# sync — configuração completa
command:
  sync:
    source:
      uri: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true'
      db: 'source-db'
    destination:
      uri: 'mongodb://localhost:27017'
      db: 'dest-db'
    logging:
      verbose: false    # default false
      progress: true    # default true
    copyIndexes: false   # default false; true = todos os índices secundários; ou lista por collection
    copyViews: false     # default false; true recria TODAS as views da origem; ou um array de nomes
    collections:
      - simple-collection
      - name: filtered-collection
        filter:
          status: "active"
      - name: big-filter-collection
        filterFile: ./filters/big.json

# migrate
command:
  migrate:
    source: { uri: '', db: '' }
    destination: { uri: '', db: '' }
    collections: []
    queryString: ''   # opcional, formato JSON.stringify
```

## Comando `ttl` — TTL em massa

Comando **standalone** (sem relação com sync). Cria índices TTL em várias collections de uma vez.

**Restrição crítica:** TTL só funciona em campo BSON `Date`. **`_id` direto é impossível** — o Mongo recusa o índice (`The field 'expireAfterSeconds' is not valid for an _id index specification`) e um campo do tipo `ObjectId` não expira (o monitor de TTL só lê `Date`). Quando a collection não tem campo de data, o pulsar **materializa** um campo `_created` a partir do `_id` via `updateMany` com pipeline (`{ $toDate: "$_id" }`), **só nos docs existentes** (`$exists:false` → idempotente). Inserts futuros não são cobertos — é one-shot; quem insere é responsável.

**Nome `_created`** (não `_ttl`): o campo guarda data de criação, não um "tempo pra expirar".

Dois modos:
- **YAML** (`pulsar ttl arquivo.yml`): granular, `defaults` + override por collection. Ver `configs/ttl-example.yml`.
- **CLI** (`pulsar ttl` + flags): config **uniforme** pra um conjunto de collections.

Derivar do `_id` é **sempre explícito** (`deriveFromId: true` / `--derive-from-id`) — nada implícito. Sem `field` nem `deriveFromId` resolvidos → erro, não executa. `field` e `deriveFromId` são mutuamente exclusivos. Precedência por collection: o que a collection define vence; senão herda do `defaults` (um `field` explícito na collection suprime um `deriveFromId` herdado e vice-versa).

**Duração** (`expire`): `30d`, `1h`, `3mo`... convertida pra `expireAfterSeconds`. Unidades: `s/sec/seconds`, `min/minutes`, `h/hours`, `d/days`, `w/weeks`, `mo/months` (30d), `y/years` (365d). **`m` sozinho é proibido** (ambíguo minuto/mês): use `min` ou `mo`. Mês=30d, ano=365d. Aceita `expireAfterSeconds` cru também.

Flags CLI: `--uri`, `--db`, `--collections a,b,c` (ou `--all`), `--field <campo>` (ou `--derive-from-id`), `--expire <dur>`. Reusa `db/conn.ts`, `functions/getCollections.ts` (incl. `--all`) e `utils/parseYml.ts`. Não exige Replica Set (TTL não usa Change Stream). Testado em `test/` (parseDuration, resolveTtlEntry, deriveCreated, applyTtl, ttlCommand). Desenho em `docs/superpowers/specs/2026-06-24-ttl-command-design.md`.

## Ambiente de teste local

`docker-compose-test.yml` sobe mongo-a (27020, replica set rs0) e mongo-b (27021). `configs/test-sync.yml` aponta para eles.

```sh
docker compose -f docker-compose-test.yml up -d
docker exec mongo-a mongosh --eval "rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]})"
bun run src/cli.ts sync configs/test-sync.yml --verbose
```

## Três portas de entrada — `pulsar`, `pulsar start`, `pulsar tui`

**`pulsar` sem argumento ABRE A TUI**; `pulsar tui` é o explícito. Houve uma
tentativa de fazer o comando nu apenas listar os comandos — o argumento (bom) é
que tela cheia sem ninguém pedir sequestra o terminal e quebra em script sem
TTY. A decisão vigente é a outra: a TUI é a porta de entrada, e o caso do
script segue coberto porque `startTui` EXIGE TTY e, sem ele, manda usar os
subcomandos em vez de estourar.

- **`pulsar`** — abre a TUI (o mesmo que `pulsar tui`).
- **`pulsar start`** (`commands/start.ts`) — o caminho **guiado, na CLI**:
  escolhe uma config detectada (ou cria uma ali mesmo), pergunta se roda **aqui
  ou em background** e, no background, **qual supervisor** — mostrando os
  indisponíveis riscados **com o motivo**, em vez de escondê-los. Mostra o
  plano completo antes de executar. Sem ink de propósito: é um fluxo linear de
  perguntas, não uma tela; usa o `prompt()` global do Bun, o mesmo do
  `compose up`. `null` do prompt (ctrl+d/EOF) encerra em vez de seguir como se
  a pessoa tivesse respondido vazio.
- **`pulsar tui`** — a interface completa, para quem vai ficar operando.

O formulário do `start` é DELIBERADAMENTE mínimo (origem, destino,
collections): o ajuste fino segue na TUI ou no yml. Reproduzir o wizard inteiro
aqui criaria duas implementações do mesmo formulário para manter em sincronia.

## TUI (`pulsar tui`)

Interface de terminal em **Ink** que cobre o ciclo inteiro sem editar yml à mão.
`pulsar` sem subcomando abre a TUI; `pulsar tui` é o explícito. Os subcomandos
não mudaram, e o import do módulo é dinâmico — quem roda `pulsar sync` num
container não carrega react/ink.

Paleta ancorada no roxo da marca (`#9b00ff`, o mesmo do banner em
`utils/showCliTitle.ts`); estados (ok/aviso/erro) seguem em ANSI-16 nomeado,
que respeita o tema do terminal. Tela cheia em *alternate screen* (sai sem
sujar o scrollback; a sequência vem de `core/tty/ansi.ts`, a MESMA que o
handoff do sudo usa).

### Uma tela raiz e uma pilha de camadas

A TUI tem **uma tela**: a **lista de serviços da máquina** (`ServicesPanel`),
em largura cheia. Todo o resto é **camada por cima dela**:

| Camada | Abre com | O que é |
|---|---|---|
| detalhe | `enter` num item | identidade + ações DAQUELE serviço |
| formulário | `n`, ou `e` no detalhe | criar/editar serviço e config, todos os campos visíveis |
| logs | `l` | tela cheia: rolagem, busca, cópia, troca de fonte |
| ajuda | `?` | as teclas da camada atual + as globais (rola quando não cabe) |
| trocar inicialização | `b` no detalhe | escolher o backend alvo — `esc` cancela sem executar nada |

Há sempre **exatamente um dono do teclado E do mouse**: a camada do topo da
pilha (prop `enabled`, que vai tanto no `useInput` quanto no `useClickable` —
com overlay aberto, um clique fora da caixa não age na lista de baixo). Isso
substituiu o `tab` que trocava foco entre painéis vivos — o
arranjo que produzia `enter` agindo sobre o painel que não estava sendo
olhado. `esc` fecha uma camada e **devolve o cursor ao mesmo item** (a lista
não desmonta, e o cursor mora no `App`); `q` sai só na raiz; **`ctrl+d` sai de
qualquer lugar**; `ctrl+c` copia (o caminho do yml do item em foco); `m`
liga/desliga o mouse na raiz. As telas `Home`, `Services`, `Running`, `Logs` e
o wizard passo-a-passo **não existem mais** — respondiam pedaços da mesma
pergunta ("que serviços existem e como mexo neles?") e nenhuma respondia
inteira.

`?` é o único caso em que `esc` não volta uma camada: fecha a ajuda e devolve
o usuário onde estava. A ajuda é **contextual e honesta** — a fonte é
`tui/keys.ts` (lista única: a barra do rodapé mostra as `primary`, o `?`
mostra todas, agrupadas), e ela é **filtrada pelo estado do item**: `a`
(adotar) só aparece em serviço sem registro, `o` (ligar boot) só em serviço
contínuo com o boot desligado. Nas camadas com campo de texto (formulário e
busca do log) o `?` é tratado DENTRO delas — uma URI do Atlas tem
`?retryWrites=true`, e um atalho global roubaria a tecla no meio da digitação.

### O registro em `~/.pulsar`

A lista é o cruzamento de duas fontes: o **registro** (`~/.pulsar/services/
<nome>.json`, um arquivo por serviço, gravado com tmp+rename) diz o
SIGNIFICADO — modo, yml, backend, boot, e o `lastRun` com os números da última
execução; `discoverServices()` diz a VERDADE VIVA — está no ar, sobe no boot.
Quatro estados aparecem na tela: `● no ar` / `○ parado`, `◍ adotado`
(supervisor sem registro), `⊘ não instalado` (registro sem supervisor) e
`✓ concluído` / `✗ erro` (one-shot que terminou). Registro corrompido nunca
derruba a lista: aquele serviço aparece como adotado e a leitura segue.

O `lastRun` é gravado **pelo próprio processo do pulsar** (`core/state/
runRecord.ts`, chamado no fim de `sync`/`migrate`/`ttl`) — o serviço roda no
boot às 3h da manhã com a TUI fechada, e o resultado precisa estar lá quando
ela abrir. No detalhe, `v` mostra os números (traduzidos por modo) ou o erro.

**Adotar** (`a`) reconstrói o registro lendo o supervisor: o `ExecStart` da
unit systemd e o `command` do container contêm o modo e o caminho do yml.
Serviço criado à mão, ou por uma versão anterior da TUI, não vira órfão.

### Sudo resolvido na criação

Só três passos em todo o código pedem root, e os três são sobre boot
(`loginctl enable-linger` como fallback, `systemctl enable docker`,
`pm2 startup`). Eles são resolvidos **na hora**, nunca relatados como
pendência no fim: o formulário avisa ao marcar `boot` (`⚠ vai precisar de sudo
(1 comando)`), a TUI roda `sudo -n true` na abertura (o chip do cabeçalho diz
`sudo liberado` / `pede senha`) e, se houver senha, a instalação **para no
ponto exato**, mostra o comando literal e espera: `enter` **larga o terminal**
para o sudo (`core/tty/handoff.ts`: sai do alternate screen, desliga mouse e
raw mode, restaura em `finally` — falhar ali deixaria o terminal sem eco) e
`p` pula. Pular **não faz a instalação falhar**: o serviço sobe, o registro
grava `boot: false` porque é a realidade, e o detalhe oferece `o` para ligar
depois (`core/service/enableBoot.ts`, a mesma máquina de passos privilegiados).

### One-shot desliga o próprio boot

`migrate` e `ttl` terminam. Ao concluir **com sucesso**, o processo desabilita
o próprio autostart antes de sair e carimba `boot: false`
(`core/service/oneshot.ts`). Duas travas: só em serviço com
`createdBy: "pulsar-tui"` e só no sucesso — desligar no erro tiraria a
retentativa sem ninguém perceber.

### Trocar o modo de inicialização

`b` no detalhe escolhe outro backend: o pulsar remove do antigo, instala no
novo e sobe, preservando nome, yml e boot. **Se o novo falhar no meio,
reinstala no antigo** em vez de deixar a máquina sem serviço nenhum
(`core/service/switchBackend.ts`); quando nem o rollback funciona, a mensagem
diz isso em letras claras.

### O formulário (criar/editar)

Um componente só, o mesmo para criar e editar: **todos os campos visíveis ao
mesmo tempo**, `↑↓` (ou clique) anda livre entre eles, `enter` abre o editor
daquele campo, `ctrl+s` cria e sobe, `ctrl+o` só grava. Não há "próximo" —
trocar o destino de um yml existente é UM campo de distância. Campo que
depende de conexão (origem.db, collections, views, índices) **nunca some**:
fica esmaecido com o motivo ao lado e, sem Mongo, aceita os nomes digitados à
mão. Conectando, viram os pickers de sempre, com busca `/` visível. O modo
(`sync`/`migrate`/`ttl`) decide quais campos existem — o `ttl` traz
campo/derivar-do-_id/duração e não tem destino. **Serviço sempre aponta para
um arquivo yml**: escolhendo `— definir aqui —`, o pulsar grava um yml novo e
vincula, o que preserva `pulsar sync arquivo.yml` fora da TUI. Backend
indisponível aparece desabilitado, **com motivo e conserto** (vindos do
`detect.ts`). O registro guarda o nome COMO O SUPERVISOR o conhece
(`pulsar-<slug>`) — é o que `reconcile` cruza com o `discover`.

> ⚠ Editar uma config existente pelo formulário **regrava o yml** e, como a
> gravação é um `yaml.dump` do objeto, **comentários e ordem das chaves se
> perdem**. Vale para o wizard antigo também; não edite pela TUI um yml cujos
> comentários sejam documentação.

### Logs em tela cheia

`l` abre o log ocupando 100% da tela — sem sidebar, sem painel de contexto, só
conteúdo e uma linha de teclas. `↑↓`/`PgUp`/`PgDn`/`g`/`G` rolam (rolar para
cima desliga o "seguir"; `G` religa), `f` alterna seguir, `/` `n` `N` buscam,
`ctrl+c` copia a linha em foco e `Y` a tela inteira (OSC 52, funciona por
SSH), `m` devolve a seleção nativa do terminal, e **`s` troca a fonte**: o
seguidor ao vivo do supervisor (`journalctl -f`, `docker logs -f`,
`pm2 logs`, `tail -F`) e cada arquivo de `./logs` do diretório de trabalho
daquele serviço.

### Rodar em primeiro plano

`r` no detalhe roda o yml daquele serviço como processo filho, com saída ao
vivo (`Runner`). Para com **SIGTERM** (o pulsar grava o resume token antes de
sair); SIGKILL só depois de 35s. A TUI nunca deixa filho órfão — por isso o
`render()` roda com `exitOnCtrlC: false` e a saída é tratada no `App`.

**Detalhe de build:** o ink referencia `react-devtools-core` e quebraria o
`bun build --compile`; `src/stubs/react-devtools-core.ts` é mapeado via `paths`
no tsconfig para resolver isso. Desenho completo em
`docs/superpowers/specs/2026-08-15-tui-service-panel-design.md` (o de
`2026-07-28-tui-design.md` descreve a camada de tela ANTERIOR). Testes em
`test/tuiKeys.test.ts`, `test/tuiService.test.ts`, `test/tuiConfig.test.ts`,
`test/tuiInspect.test.ts`, `test/tuiLayout.test.ts` (geometria pura da barra de
teclas), `test/tuiMouse.test.ts` (parse SGR e hit-testing), `test/state.test.ts`
e `test/privileged.test.ts`.

## Pontos de atenção

- Change Streams exigem Replica Set na origem. Standalone retorna erro.
- `freeze.ts` faz `updateMany({ "__sync.hot": true }, { $unset: { "__sync.hot": "" } })` no destino — limpa `hot` velho antes do dump (só roda no caminho de dump; o caminho de resume não chama freeze).
- `configs/dump.yml` e `configs/sync.yml` ficam no `.gitignore` pois contêm credenciais. Usar `configs/test-sync.yml` como referência.
- Deleções offline (com watch desligado) **são propagadas** no restart quando a collection retoma pelo resume token (via oplog). Só ficam de fora se a collection cair no caminho de dump (token expirado/`--full`), pois o cursor não enxerga o que já foi apagado na origem.
- `filterFile` paths são relativos ao CWD, não ao arquivo yml.

## Shutdown gracioso e preempção (`commands/sync.ts`)

**Isto é do CÓDIGO, não do Docker.** Vale rodando de qualquer jeito — `bun src/cli.ts sync`, binário, systemd ou container. O Docker/compose só oferecem botões *opcionais* de ajuste fino (ver a seção do compose abaixo); nada do mecanismo depende deles.

**Como funciona — a cadeia do sinal:**

1. Algo pede pro processo encerrar e o SO entrega um sinal **capturável**:
   - `Ctrl+C` → SIGINT
   - `kill <pid>`, `docker stop`, ou `systemctl stop` → SIGTERM
   - **Preempção de VM** (spot/preemptible) ou desligamento da máquina → o hypervisor dispara um evento **ACPI** (power/reset), o `systemd`/`acpid` da VM intercepta e inicia o shutdown ordenado, que **manda SIGTERM** pros processos antes de cortar a energia (cortesia de ~30s a 2 min, depende do provedor).
2. `sync.ts` registra `process.once("SIGINT" | "SIGTERM", shutdown)` **antes** do dump começar — então um sinal no meio da conexão/listagem também é tratado.
3. `shutdown()` faz, em ordem: `engine.stop()` → **flush do resume token global + flush das fronteiras de dump incompletas** (pra retomar tight) → fecha o change stream → fecha as 2 conexões Mongo.
4. `process.exit()`. No próximo boot, cada collection **RETOMA pelo token** em vez de re-dumpar.

**Garantia de saída:** o `shutdown()` corre contra um timer (`PULSAR_SHUTDOWN_TIMEOUT_MS`, default 30s) — se `close()` pendurar (ex.: stream travado no loop do evento >16MB), o processo força o exit mesmo assim. O flush do checkpoint acontece *primeiro*, então é salvo mesmo no caminho forçado.

**O que NÃO dá pra tratar:** SIGKILL (`kill -9`), o **OOM killer** e morte abrupta da VM (queda de energia/rede) **não são interceptáveis** — é design do kernel. Mas não há vazamento de conexão: ao morrer o processo, o kernel fecha os sockets (manda RST) e o Atlas derruba a escuta. Só uma morte *instantânea* da VM (sem ACPI) deixa a conexão pendurada — e aí quem reapeia é o keepalive/timeout do lado do Atlas, nada que o pulsar possa fazer.

> ⚠️ ACPI ≠ config. O `stop_grace_period` do compose **não** "liga o ACPI" — ele só diz *quanto o Docker espera* o SIGTERM ser tratado antes de mandar SIGKILL. Fora do Docker, quem dá esse tempo é o `DefaultTimeoutStopSec` do systemd (se rodar como serviço) ou o próprio provedor da VM.

## Produção: rodar 24/7 em VM (`docker-compose-limit.yml`)

Opção **recomendada mas não obrigatória** pra VM de longa duração: roda o `sync` num container com **cerca de recursos** (cgroups) e logs rotacionados. **É contenção, não conserta os bugs de consumo** (backpressure ausente no `engine.ts` e evento de change stream >16MB), só impede que derrubem a VM. Sem Docker, o sync roda igual — você só perde a cerca de RAM/CPU automática.

```sh
docker compose -f docker-compose-limit.yml up -d --build
docker stats pulsar-sync     # ver RAM/CPU batendo no teto
```

- **Teto de RAM/CPU:** `mem_limit` + `memswap_limit` (== mem_limit, p/ proibir swap) + `cpus`. No estouro o kernel faz OOM kill **do container** (não da VM); `restart: unless-stopped` sobe de novo. `nice`/`taskset` não limitam RAM — por isso a cerca é via cgroup. O arquivo documenta unidades e dimensionamento.
- **Botões do shutdown (opcionais, Docker-only):** `stop_grace_period` = quanto o Docker espera o SIGTERM ser tratado; `PULSAR_SHUTDOWN_TIMEOUT_MS` (env) = teto interno do `shutdown()` — mantenha-o **< `stop_grace_period`**. No desligamento do *host* quem manda é o `shutdown-timeout` do daemon (`/etc/docker/daemon.json`, default 15s); e `systemctl enable docker` faz o container voltar sozinho na realocação.
- **Rotação de logs (`utils/customLog.ts`):** transports do winston com `maxsize`/`maxFiles`/`tailable`, via env `LOG_MAX_SIZE` (bytes) e `LOG_MAX_FILES`. Teto de disco ≈ `LOG_MAX_SIZE × LOG_MAX_FILES` por nível. **Independe do Docker** (os defaults valem rodando bare). O compose adicionalmente capa os logs do **container** (json-file `max-size`/`max-file`) — fluxo separado da pasta `./logs`.
- **STATUS heartbeat (`utils/progressManager.ts`):** sem TTY (container/pm2/systemd) as barras são desligadas; no lugar, um bloco consolidado é impresso a cada `STATUS_INTERVAL_MS` (default 10s; `0` desliga) mostrando, por dump ativo, barra de texto `█░` + % + docs, mais contadores (`concluídos`/`em andamento`/`total`). Legível mesmo sem cor. Só roda durante o dump inicial (`startStatusReporter`/`stopStatusReporter` em `sync.ts`); no modo TTY as barras continuam normais.

### Múltiplas instâncias paralelas — `pulsar compose up` (`commands/compose.ts`)

Pra rodar mais de um `sync` na mesma VM (datasets diferentes), o `docker-compose-limit.yml` sozinho **não serve**: ele fixa `container_name: pulsar-sync`, então `up` de novo é no-op (mexe no mesmo container). O `pulsar compose up` é um comando **interativo** que gera um `docker-compose-limit-<N>.yml` próprio pra cada instância nova:

1. **Lê o `docker-compose-limit.yml` do diretório atual como base** (fonte única — a nova instância herda env/stop_grace/logging que você calibrou) e troca: `container_name`/serviço → `pulsar-sync-<N>`, o `command`+volume da config, e o volume de logs → `./logs-<N>`.
2. **Detecta as configs do pulsar** na pasta (`detectConfigs.ts` classifica por `command.sync/migrate/ttl`) e oferece as de **sync**, mostrando o **destino** de cada uma (ajuda a não apontar duas pro mesmo destino).
3. **Recomenda recursos pelo USO atual** (`recommend.ts`): orçamento ~65% da RAM e ~1 núcleo livre, **menos o que as instâncias existentes já comprometeram** (lido via `docker inspect` dos `pulsar-sync*`) — assim o somatório não estoura a VM. Padrão é aplicar o recomendado (Enter); manual é opcional.
4. Oferece subir na hora (`docker compose -f docker-compose-limit-<N>.yml up -d --build`).

**Crítico:** cada instância DEVE apontar pra um **destino diferente** (db/collections sem sobreposição). Dois `sync` no mesmo destino brigam pelo resume token global (`__sync`) e duplicam escrita. Os `docker-compose-limit-*.yml` e `logs-*/` gerados ficam no `.gitignore`. Lógica pura testada em `test/compose.test.ts`.
