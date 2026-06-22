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
bun run src/cli.ts migrate configs/test.yml -p 4
bun run src/cli.ts sync configs/test.yml
bun run src/cli.ts sync configs/test.yml --verbose
```

## Estrutura

```
src/
  cli.ts                  # entrypoint, define os comandos CLI
  commands/
    migrate.ts            # orquestra o fluxo completo de dump/restore
    sync.ts               # orquestra o fluxo de watch; inicializa logConfig
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

### Restart incremental — resume token (`core/sync/engine.ts`)

No restart, **cada collection decide entre RETOMAR ou re-DUMPAR**:

- **Retoma** (pula o dump) quando o dump anterior concluiu (`dumpCompletedAt`) **e** há um resume token global salvo. O `db.watch` reabre com `startAfter: token` → o oplog reentrega tudo que mudou offline (insert/update/**delete**), em segundos, **sem re-escanear**.
- **Re-dumpa** quando: nunca terminou o dump, não há token, ou `--full`. Se o **token global** expirar (oplog estourado → `286 ChangeStreamHistoryLost`), o stream único cai em **forceDumpAll** → re-dumpa **todas** (perdeu-se a posição de todas de uma vez — é o tradeoff do token único).

Estado no `__sync` do destino: 1 doc por collection `{ id, dumpCompletedAt, dumpCursorId }` + 1 doc global `{ id: "__pulsar_db__", resumeToken, tokenUpdatedAt }`.

- `dumpCompletedAt` é carimbado **só quando o dump conclui de fato** (`dumpCollections` retorna `true`).
- `resumeToken` é o PBRT do `db.watch` (**um só, global**), persistido a cada ~5s pelo `ResumeTokenCheckpointer`. Um `kill -9` perde no máximo ~5s; SIGINT/SIGTERM fazem flush final antes de sair.
- `--full` (`-f`) ignora os carimbos e força dump completo de tudo (reconciliação total).

**Dump retomável (`dumpCursorId`):** se um dump **não termina** (interrompido, timeout de conexão), o cursor (que varre `_id:-1`) carimba a fronteira — o menor `_id` já processado — no `__sync` a cada ~5s (`saveDumpProgress`). No restart, um dump incompleto **continua de `find({ _id: { $lt: dumpCursorId } })`** em vez de recomeçar do zero. `markDumpCompleted` limpa a fronteira ao concluir; `--full` a ignora. Limitação: mudanças offline na faixa **já dumpada** (`_id ≥ fronteira`) não são reconciliadas nesse caminho (stream reabre fresh, não por token) — só um `--full` cobre.

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
