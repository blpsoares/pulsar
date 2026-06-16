# Mongo Pulsar — CLAUDE.md

CLI em Bun/TypeScript para sincronização de dados entre bancos MongoDB. Dois modos: `migrate` (snapshot via mongodump/mongorestore) e `sync` (watch contínuo via Change Streams).

## Stack

- **Runtime:** Bun
- **Linguagem:** TypeScript
- **Driver:** mongodb v6
- **CLI:** commander
- **Rate limiting:** bottleneck (controla paralelismo de operações Mongo)
- **Linter:** Biome

## Comandos úteis

```sh
bun run bin:dev        # compila e instala o binário em ~/.local/bin/pulsar
bun run bin:prod       # compila para dist/pulsar sem instalar
bun run src/cli.ts migrate configs/test.yml -p 4   # roda direto sem compilar
bun run src/cli.ts sync configs/test.yml
```

## Estrutura

```
src/
  cli.ts                  # entrypoint, define os comandos CLI
  commands/
    migrate.ts            # orquestra o fluxo completo de dump/restore
    sync.ts               # orquestra o fluxo de watch
  core/
    dump/
      dump.ts             # exporta collections via mongodump (com resume se temp-dump existir)
      restoreDump.ts      # restaura via mongorestore com prefixo _dump_
      initSync.ts         # registra estado inicial na collection __sync do destino
      dropOldCollections.ts
      renameCollections.ts
    sync/
      index.ts            # eventHandler: abre change stream + dispara dump inicial
      dumpEvent.ts        # cursor completo com comparação por hash (pula docs idênticos)
      watcherEvents.ts    # EventEmitter central para eventos do change stream
      insertEvent.ts
      updateEvent.ts
      deleteEvent.ts
      replaceEvent.ts
  functions/
    getCollections.ts     # resolve lista de collections (yml ou flag -a)
    freeze.ts             # chamado no início do sync (operação no destino)
  utils/
    mongo.ts              # addFieldsOnMongoDocument + hash SHA-1 + MongoStatusReturns
    parseYml.ts           # valida yml via Zod
    customLog.ts          # logger (terminal + arquivo)
    ...
  types/
    parseYml.ts           # schemas Zod e tipos exportados
```

## Comportamento crítico do sync

### Dump inicial com hash comparison (`core/sync/dumpEvent.ts`)

Ao iniciar/reiniciar o watch, cada collection passa por um cursor completo. Para cada documento:

1. Busca `__sync.hash` do doc no destino
2. Computa hash SHA-1 do doc no source (sem os campos `__sync`/`origin`)
3. **Hash igual** → pula (zero writes)
4. **Hash diferente** → `updateOne`
5. **Doc ausente** → `insertOne`

Isso permite reiniciar o watch adicionando novas collections sem reprocessar os 60k docs existentes.

### Campos adicionados nos docs do destino

```json
{
  "__sync": { "hot": true, "ts": <epoch_ms>, "hash": "<sha1>" },
  "origin": "dump | watch:insert | watch:update | watch:replace"
}
```

O hash é calculado a partir do documento **original** (antes de adicionar `__sync`/`origin`), então a comparação funciona mesmo que o doc do destino tenha os metadados.

### Change Stream

Aberto em `core/sync/index.ts` com `fullDocument: "updateLookup"`. Não persiste resume token — ao reiniciar, eventos offline são capturados pelo dump inicial (exceto deleções).

### Deleções offline

Deleções feitas enquanto o watch está desligado **não são propagadas** no reinício. O cursor `find()` só enxerga docs que existem. Workaround atual: nenhum (aceito pelo projeto).

## Formato dos YMLs

```yaml
# sync
command:
  sync:
    source: { uri: '', db: '' }
    destination: { uri: '', db: '' }
    collections: []   # omitir ou usar flag -a para todas

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
bun run src/cli.ts sync configs/test-sync.yml
```

## Pontos de atenção

- Change Streams exigem Replica Set na origem. Standalone retorna erro.
- `freeze.ts` faz `updateMany({ hot: { $exists: true } }, ...)` — filtra campo `hot` na raiz, não em `__sync.hot`. Não tem efeito prático (nenhum doc tem `hot` na raiz), mas não quebra nada.
- `configs/dump.yml` e `configs/sync.yml` ficam no `.gitignore` pois contêm credenciais. Usar `configs/test-sync.yml` como referência.
