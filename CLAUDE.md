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
bun run src/cli.ts migrate configs/test.yml -p 4
bun run src/cli.ts sync configs/test.yml
bun run src/cli.ts sync configs/test.yml --verbose
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
      insertEvent.ts      # loga [collection] insert | _id quando verbose
      updateEvent.ts      # loga [collection] update | _id quando verbose
      deleteEvent.ts      # loga [collection] delete | _id quando verbose
      replaceEvent.ts     # loga [collection] replace | _id quando verbose
    ttl/
      parseDuration.ts      # "30d"/"1h"/"3mo" -> segundos (mês=30d, ano=365d; 'm' proibido)
      resolveTtlEntry.ts    # precedência defaults+override por collection; erro se não resolve
      deriveCreated.ts      # updateMany pipeline { $toDate: "$_id" } -> campo _created (idempotente)
      applyTtl.ts           # materializa (se preciso) + createIndex TTL por collection
    compose/
      recommend.ts          # recomenda recursos: orçamento (~65% RAM, ~1 core livre) MENOS o já comprometido pelas instâncias existentes
      buildCompose.ts       # gera o compose da nova instância a partir do docker-compose-limit.yml base (troca nome/config/volumes/recursos)
      detectConfigs.ts      # varre *.yml e classifica por command.sync/migrate/ttl (mostra destino)
  functions/
    getCollections.ts     # resolve lista de collections; carrega filter/filterFile
    freeze.ts             # chamado no início do sync (operação no destino)
  utils/
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
