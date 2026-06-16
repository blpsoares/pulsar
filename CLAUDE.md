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
      index.ts            # eventHandler: abre change stream + dispara dump inicial
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
- `freeze.ts` faz `updateMany({ hot: { $exists: true } }, ...)` — filtra campo `hot` na raiz, não em `__sync.hot`. Não tem efeito prático (nenhum doc tem `hot` na raiz), mas não quebra nada.
- `configs/dump.yml` e `configs/sync.yml` ficam no `.gitignore` pois contêm credenciais. Usar `configs/test-sync.yml` como referência.
- Deleções offline (com watch desligado) não são propagadas no reinício — limitação conhecida e aceita.
- `filterFile` paths são relativos ao CWD, não ao arquivo yml.
