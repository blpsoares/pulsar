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
pulsar                 # sem argumento: abre a TUI (Ink) — cria config, roda, instala serviço, lê log
pulsar tui             # idem, explícito
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
    service/                # [TUI] background: systemd, launchd, pm2, docker + detect/manager
    logs/                   # [TUI] readLog (tail pela cauda), tailCommand (journalctl/pm2/docker/tail)
  tui/
    index.tsx             # render da TUI; exige TTY (sem TTY manda usar os subcomandos)
    App.tsx               # roteador de telas (rotas raiz = abas; resto = sub-tela com crumb)
    theme.ts              # paleta/glifos
    layout.ts             # geometria pura: colunas, CHROME_ROWS, células das abas, shortenPath
    components/           # Shell (abas+painéis+teclas), Select, TextInput, ConfigTree, ActionMenu
    mouse/                # parse SGR (1000+1006) + MouseProvider (hit-testing; shift libera a seleção)
    hooks/                # useInspector (Mongo), useProcess (filho), useSpinner, useBackgroundStart
    screens/              # Home, Wizard, Runner, Running, Services, Logs, ServiceLogs (+ wizard/*)
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

O copy doc-a-doc do sync **não** traz os índices secundários da origem (só os dados; `migrate` via mongorestore traz). Com `copyIndexes: true` no yml, o sync replica os índices da origem no destino: faz um **diff por assinatura** (key+opções) e cria **só os que faltam** — num banco já migrado, a maioria das collections nem recebe escrita. Collection que dumpa cria o índice **depois** do dump (build em lote, igual mongorestore); collection que resume completa no startup. Falha de `createIndex` (ex.: conflito de nome) é **contida** (loga, não aborta o sync) e re-tentada no próximo startup. Nunca remove índices que existem só no destino. Painel final mostra `Índices · criados/já existiam/falhados`. Lógica em `core/sync/copyIndexes.ts`, testes em `test/copyIndexes.test.ts` e `test/engine.copyIndexes.test.ts`.

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
    copyIndexes: false   # default false; true replica índices secundários da origem no destino
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

## TUI (`pulsar` sem argumento)

Interface de terminal em **Ink** que cobre o ciclo inteiro sem editar yml à mão.
`pulsar` sem subcomando abre a TUI; `pulsar tui` é o explícito. Os subcomandos
não mudaram, e o import do módulo é dinâmico — quem roda `pulsar sync` num
container não carrega react/ink.

Paleta ancorada no roxo da marca (`#9b00ff`, o mesmo do banner em
`utils/showCliTitle.ts`); estados (ok/aviso/erro) seguem em ANSI-16 nomeado,
que respeita o tema do terminal.

**Layout de cockpit** (estilo k9s/lazygit): tela cheia em *alternate screen*
(sai sem sujar o scrollback), com painel central + painel de contexto visíveis ao
mesmo tempo. `tab` alterna **apenas o foco**, nunca o conteúdo de um
painel — trocar o que está na tela ao mudar de foco desorienta. As larguras vêm de
`src/tui/layout.ts` (matemática pura, testada): abaixo de 96 colunas o painel da
direita sai de cena antes de espremer a lista. **Ctrl+D encerra de qualquer
tela** (Ctrl+C passou a COPIAR) — o `render()` roda com `exitOnCtrlC: false`
(para o filho receber SIGTERM e gravar o resume token), então a saída é tratada
no `App`.

**Navegação global em ABAS no topo** (`1 configs · 2 rodando · 3 logs ·
4 serviço`), não em sidebar à esquerda: a sidebar cobrava ~19 colunas de toda
tela o tempo inteiro para exibir quatro itens que quase nunca mudavam, e essas
colunas faltavam justamente onde a informação é longa (caminhos de config,
linhas de log). Teclas `1..4`, `shift+tab` e `ctrl+←/→`; a faixa é clicável por
coluna (`tabCells`/`tabAt` em `layout.ts` — a MESMA conta desenha e mapeia o
clique). `tab` sozinho continua sendo só o foco DENTRO da tela. Dois freios:
`lockTabs` (Runner com processo vivo: trocar de aba mataria o sync) e
`digitKeys` (wizard e busca dos logs, onde `1` precisa escrever "1"). Sub-telas
(wizard, runner, services) mantêm acesa a aba de origem e se anunciam pelo
"crumb" ao lado das abas. Quem publica isso é o `NavContext`, não uma prop — uma
tela nova que esquecesse de repassar a prop apareceria sem abas e quebraria a
altura fixa do chrome.

O `CHROME_ROWS` (9) reserva **uma linha a mais** do que o Shell desenha. Não é
folga decorativa: quando a soma fecha exatamente a altura do terminal, o yoga
espreme o primeiro item flexível — medido, a faixa de abas rendeu uma linha em
branco (rótulos sumidos, régua intacta) a 40 linhas. A barra de teclas ocupa
**duas** linhas com quebra por palavra, porque truncar escondia sempre as mesmas
teclas do fim (mouse, sair) numa tela cheia de atalhos.

- **Descoberta recursiva:** a TUI varre da pasta atual **para baixo** procurando
  ymls do pulsar — não é preciso `cd` até onde a config mora; o caminho relativo
  aparece na lista. A varredura tem tetos de profundidade, de pastas ignoradas
  (`node_modules`, ocultas, `logs`…), de arquivos e **de tempo** (400ms): medido,
  varrer uma HOME real levava 1,3s e a partir de `/` não terminava, porque o
  custo está em percorrer pastas, não em ler os poucos ymls. Quando algum teto
  corta a varredura, a tela **avisa** em vez de deixar concluir que a config não
  existe. `detectConfigs` segue não-recursivo por padrão — o `compose up` depende
  disso.
- **Mouse e cópia:** a TUI é clicável — item de lista, cabeçalho de seção,
  passo do wizard e painel (clicar dá foco); roda do mouse rola as listas. Os
  eventos chegam pelo `useInput` do ink, **não** por um listener em
  `process.stdin`: o ink 7 lê o stdin em modo `readable` (pull), e registrar um
  `on("data")` disputa os bytes com ele — o listener não recebe nada e ainda
  arrisca engolir teclas. Rastrear cliques **rouba a seleção de texto nativa**
  do terminal; por isso `ctrl+c` COPIA o item em foco (via OSC 52, que funciona
  através de SSH, com pbcopy/wl-copy/xclip como reforço), **`shift+arrastar`
  seleciona texto** (o `MouseProvider` ignora todo evento com shift, antes do
  hit-testing — a maioria dos terminais nem manda o evento, mas nos que mandam o
  press abria o menu do item sob o cursor) e `m` na tela inicial
  desliga o mouse quando você quiser selecionar com o mouse mesmo. O
  `shift+arrastar` é anunciado pelo `Shell` na barra de teclas enquanto o mouse
  está ligado — sem isso a única fonte da informação era um comentário de código.
  A TUI fica no modo 1000+1006 (press/release/roda, SGR); 1002 passaria a
  reportar arrasto (o próprio gesto de selecionar) e 1003, movimento sem botão.
  **Todo `useInput` que aceita texto livre precisa da guarda `isMouseInput`** —
  o ink entrega a sequência SGR como se fosse digitação, então sem ela um
  clique escreve `[<0;10;5M` dentro da URI (`TextInput`) ou do termo de busca
  (`CollectionPicker`), e a lista esvazia sem explicação.
  **Sair é `q` (na
  tela inicial) ou `ctrl+d` (de qualquer lugar).** O `ctrl+d` é acrescentado à
  barra de teclas pelo próprio `Shell`, não por cada tela: uma tela que
  esquecesse de anunciá-lo deixaria o usuário preso sem saber como sair — foi
  o que aconteceu no passo "modo", que ainda por cima não tratava `esc`.
  Acrescentar não bastava: a barra tem **altura fixa** (2 linhas, reservadas no
  `CHROME_ROWS`) e o texto quebra por palavra, então o excedente não era
  truncado com reticências — a terceira linha era recortada inteira e o
  `ctrl+d` sumia sem deixar rastro, justamente na tela inicial. `fitHints`
  (`layout.ts`, puro e testado) orça a largura ANTES de renderizar: as teclas
  obrigatórias (abas, `shift+arrastar`, `ctrl+d`) reservam espaço primeiro e as
  da tela ocupam o resto, caindo fora do fim para o começo — cada tela lista da
  mais para a menos usada, então é a ordem certa de sacrificar.
- **Ações no ITEM, não numa barra de verbos:** enter (ou clique) sobre uma
  config abre o menu DELA — editar, rodar aqui, iniciar em background, gerenciar
  background, ver logs. Antes os verbos ficavam na sidebar e era preciso deixar
  o arquivo certo selecionado na lista para então escolher o verbo do outro lado
  da tela; duas metades sem nada ligando uma à outra. O que é global subiu para
  as abas (configs/rodando/logs/serviço); na tela inicial sobraram `n` (nova
  config) e `q` (sair), ambos anunciados nas hints.
- **`b` sobe em background num passo** (`hooks/useBackgroundStart.ts`): instala
  com o backend nativo da máquina, liga no boot e sobe — dizendo no rodapé se
  ficou faltando um comando com sudo. A tela de background segue existindo para
  escolher backend, ver o plano completo ou remover.
- **Tela "background" (`screens/Running.tsx`)** lista o que está no ar em
  QUALQUER supervisor (`core/service/discover.ts` varre systemd, pm2, docker e
  launchd), com estado, boot e i/p/t para iniciar/parar/reiniciar. Responde "isso
  aqui está rodando?" sem partir de uma config.
- **Navegação:** `1..4` troca de aba; `tab` alterna o painel em foco DENTRO da
  tela. O trilho da esquerda que sobrou em Logs/Services/Runner/Wizard/serviço é
  CONTEÚDO (fonte do log, backend, opções, passos), não navegação — por isso
  `layout()` só o reserva a pedido (`RAIL_WIDTH`, 22 colunas) e o devolve ao
  centro quando a tela aperta. No wizard, o trilho de
  **passos** é focável e clicável — é o que torna um yml existente realmente
  editável: dá para pular direto para "origem" ou "avançado" em vez de apertar
  `esc` até voltar.
- **Lista agrupada:** as configs achadas na varredura recursiva aparecem
  agrupadas por pasta, com seções que abrem e fecham (`←/→`, enter ou clique).
  A navegação percorre LINHAS ACHATADAS (cabeçalhos + itens visíveis), então
  seta para baixo atravessa seções sem estado de "em que nível estou".
- **Criar/editar config:** form guiado (modo → origem → destino → collections →
  avançado → revisar). Conecta na origem de verdade, lista os bancos **com
  tamanho**, e mostra collections e views com **busca incremental** (`/`) e
  multi-seleção. Abrir um yml existente **reconecta sozinho** pela URI do
  arquivo (sem isso, o passo de collections viria vazio e o yml seria
  não-editável na prática) e **preserva os `filter`/`filterFile`** escritos à
  mão. Valida com os mesmos schemas Zod do `parseYml` **antes** de gravar, e
  grava atomicamente (tmp + rename).
- **Retrato do banco (`core/inspect/dbStats.ts`):** ao mover o cursor pela lista
  de bancos, o painel da direita mostra collections, views, índices, docs (~) e
  tamanho em disco — UMA chamada `dbStats`, que lê catálogo e responde em
  milissegundos. As contagens de collections/views exibidas vêm da LISTA, não do
  `dbStats`: ele conta `system.views` como collection e o número na tela tem que
  bater com o que dá para selecionar.
- **Estimativas (opt-in):** o painel `e` liga "show estimatives" e escolhe quais
  métricas puxar. Por padrão a tela não conta nada — `countDocuments` numa
  collection de 215M docs levaria minutos. Os números vêm de `$collStats`
  (metadata, instantâneo) e aparecem com `~`; `c` faz a contagem exata da
  collection sob o cursor. O resumo "vai ser enviado" muda por modo (sync conta
  índices só com `copyIndexes`; migrate leva índices sempre; ttl não copia dado)
  e avisa quando uma view aponta para collection fora da seleção.
- **Rodar:** dispara `sync`/`migrate`/`ttl` como processo filho com a saída ao
  vivo. Para com **SIGTERM** (o pulsar grava o resume token antes de sair);
  SIGKILL só depois de 35s. A TUI nunca deixa filho órfão — e há dois jeitos de
  furar isso, ambos fechados:
  - **Spawn depois do desmonte.** Quando o `start` vem DEPOIS de um `await`
    (detectar backend, ler o yml), o desmonte pode cair no meio: o cleanup roda
    antes de existir processo para matar, e o filho nasce órfão, sobrevivendo à
    TUI. Todo efeito assíncrono que spawna carrega uma flag `vivo`, checada
    também **entre o `await` e o `start`**.
  - **Um spawn por tecla.** Trocar a fonte remonta o visualizador, o que no
    caso "ao vivo" mata um `journalctl -f` e abre outro. Descer dez itens com a
    seta criava e matava dez processos. O cursor anda na hora, mas o
    visualizador segue um índice **estabilizado** (`hooks/useSettled.ts`, 250ms):
    a seleção visível continua instantânea e só o efeito caro espera a mão parar.
  - **Sinal que não encerra.** `process.once("SIGTERM", restore)` substituía a
    ação padrão do sinal por "só restaurar a tela": a TUI passava a **ignorar**
    `kill` e o fechamento do terminal. Os handlers de SIGTERM/SIGHUP restauram
    **e saem** (128+sinal), e o de `uncaughtException` restaura, imprime o erro
    (que o alternate screen esconderia) e sai com falha.
- **Background e boot:** systemd (unit de *usuário*, sem sudo), launchd
  (LaunchAgent), pm2 (ecosystem file) e docker (herda o
  `docker-compose-limit.yml`). A tela detecta o que existe na máquina, mostra o
  **plano completo** (arquivos + comandos) antes de executar, e **nunca roda
  sudo** — passos privilegiados (`enable-linger` de fallback, `pm2 startup`) são
  listados para você rodar. Instalar/iniciar/parar/remover e status vivem na
  mesma tela.
  - **Detecção honesta do systemd (`core/service/detect.ts`):** disponibilidade
    exige TRÊS evidências — `/run/systemd/system` (systemd é o init), o socket
    do bus de usuário e um estado válido em `systemctl --user is-system-running`.
    Antes bastava "o comando existe", e em WSL/container o erro *Failed to
    connect to bus: No medium found* sai com código numérico e era lido como
    "disponível" — o backend era oferecido e falhava na instalação. `degraded`
    continua aprovado (sai != 0, mas tem bus). O julgamento é uma função PURA
    (`judgeSystemdUser`) sobre a sonda, testável sem systemd.
  - **Docker não pede sudo:** `restart: unless-stopped` já basta (o daemon subir
    no boot é o padrão do pacote da distro, e Docker Desktop/WSL/colima nem têm
    a unit). Sobrou só uma NOTA condicional, quando há systemd de sistema real e
    a unit está comprovadamente `disabled`.
  - **Falha acionável:** um passo que falha devolve "comando — causa · saída
    sugerida" numa linha (`stepFailure`/`adviseFailure`) — bus ausente vira
    "troque o backend para docker ou pm2", e não um dump de stderr.
  - **A presença do compose é MEDIDA, não presumida.** `detectBackends` recebe
    um booleano dizendo se há `docker-compose-limit.yml` na pasta, e passá-lo
    fixo elimina (ou inventa) o docker silenciosamente. O atalho `b` passava
    `false` e respondia "nenhum supervisor disponível" numa máquina com docker
    instalado e o compose ao lado; a visão ao vivo dos logs passava `true` e
    elegia docker onde ele não roda. Ambos usam `existsSync` agora, e a
    negativa lista o motivo de CADA backend em vez de só dizer não.
- **Logs (aba 3):** duas visões — *gravados* (`./logs/*.log`, lidos pela cauda,
  com busca e follow) e *ao vivo* (seguidor nativo: `journalctl -f`, `pm2 logs`,
  `docker logs -f`, `tail -F`). O filho roda sem TTY, então o pulsar já troca as
  barras pelo bloco STATUS — formato que cabe no painel.
- **Serviço (aba 4, `screens/ServiceLogs.tsx`):** log ao vivo do que está em
  background, escolhido na lista do `discoverServices()` — o par (backend, nome)
  vem do próprio supervisor, em vez de ser adivinhado por `preferredBackend()` +
  nome do yml, que era o defeito da visão "ao vivo" da aba de logs. O cursor da
  lista é SEPARADO do serviço seguido: seguir por highlight derrubaria e subiria
  um `journalctl` a cada seta, então `enter` (ou clique no item já sob o cursor)
  é que compromete. O seguidor vive num componente com `key` =
  `backend:nome#recargas` — trocar de serviço, `R` ou sair da aba desmonta e o
  cleanup manda SIGTERM (sem órfão). Quando o seguidor falha, `followIssue()`
  (pura, testada) traduz a causa — binário ausente, systemd sem bus, `No such
  container` — em vez de deixar painel vazio, e distingue os três silêncios
  (abrindo / seguindo sem saída / seguidor encerrou).

**Detalhe de build:** o ink referencia `react-devtools-core` e quebraria o
`bun build --compile`; `src/stubs/react-devtools-core.ts` é mapeado via `paths`
no tsconfig para resolver isso. Desenho completo em
`docs/superpowers/specs/2026-07-28-tui-design.md`. Testes em
`test/tuiConfig.test.ts`, `test/tuiService.test.ts`, `test/tuiInspect.test.ts`,
`test/tuiLayout.test.ts` (geometria + abas), `test/tuiMouse.test.ts` (parse e
hit-testing) e `test/tuiServiceLogs.test.ts`.

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
