# Comando `ttl` — criar TTL em massa (design)

**Data:** 2026-06-24
**Status:** aprovado, pronto pra plano de implementação

## Problema

Precisamos criar índices TTL (expiração automática de documentos) em **várias collections de uma vez**, a partir do pulsar. Hoje isso é feito à mão, collection por collection, no shell do Mongo.

## Restrição técnica fundamental (provada)

**TTL só funciona em campo do tipo BSON `Date`.** O monitor de TTL do Mongo varre o índice e só apaga docs onde o campo indexado é uma data de verdade (`Date + expireAfterSeconds < agora`). Se o campo não é `Date`, ele ignora.

**Não dá pra usar o `_id` direto**, por dois motivos comprovados nos containers de teste (`mongo-a`):

1. `createIndex({ _id: 1 }, { expireAfterSeconds: N })` → erro do Mongo: *"The field 'expireAfterSeconds' is not valid for an _id index specification."*
2. Um campo que guarda um `ObjectId` (mesmo com o timestamp embutido) **não expira** — provado: mesmo `expireAfterSeconds:1`, campo `Date` antigo foi apagado, campo `ObjectId` antigo sobreviveu.

Sortear por `_id` funciona (ObjectId é ordenável byte a byte), mas isso é **comparação**, não TTL. São mecanismos diferentes.

**O Mongo não guarda carimbo de criação escondido por documento.** A única fonte de "quando o doc foi criado" é o timestamp dentro do `_id`. Pra usar isso em TTL, precisamos **materializar** esse timestamp num campo `Date`.

## Solução

Comando novo e **standalone**: `pulsar ttl`. Roda, cria os TTLs, finaliza. **Não tem nada a ver com `sync`** — é um comando à parte.

Dois modos de uso:

- **YAML** — casos granulares (global + overrides por collection).
- **CLI direto** — caso uniforme (mesma config aplicada a um conjunto de collections), sem precisar de arquivo.

### Materialização do campo de criação (`deriveFromId`)

Quando a collection **não tem** um campo `Date` pra usar, e o usuário opta **explicitamente** por derivar do `_id`, o pulsar materializa um campo de data de criação antes de criar o índice:

```js
db.collection.updateMany(
  { _created: { $exists: false } },          // só nos docs que ainda não têm
  [ { $set: { _created: { $toDate: "$_id" } } } ]  // pipeline com valor computado
)
db.collection.createIndex({ _created: 1 }, { expireAfterSeconds: N })
```

Decisões:

- **Nome do campo: `_created`** (não `_ttl`). `_ttl` é contraditório — TTL é "tempo pra expirar", e o campo guarda **data de criação**. `_created` descreve o que de fato é.
- **Update é retroativo e imediato** (`updateMany` sobre os existentes), **não** via watch. Watch só pegaria docs futuros; precisamos carimbar os que já existem.
- **Usa o pipeline-form do `updateMany`** com valor computado (`$toDate: "$_id"`) — disponível nas versões novas do Mongo; aplica a todos de uma vez, sem cursor + `updateOne` doc a doc.
- O filtro `{ _created: { $exists: false } }` torna a operação **idempotente**: rodar de novo não reescreve quem já tem.
- **Limitação conhecida:** documentos **novos** inseridos depois do comando rodar **não ganham `_created` sozinhos** — quem insere (app) é responsável. Este comando é one-shot sobre o estado atual; cobrir inserts futuros está fora de escopo (seria amarrar ao sync, que decidimos não fazer).

### Nada implícito

Derivar do `_id` **nunca** acontece silenciosamente por omissão de campo. É sempre escolha explícita (`deriveFromId: true` no yml ou `--derive-from-id` na CLI). Se, ao resolver uma collection, não houver **nem** `field` **nem** `deriveFromId` → **erro claro** ("collection X sem campo de TTL definido"), e nada é executado.

## Formato YAML

```yaml
command:
  ttl:
    source:
      uri: 'mongodb://...'        # placeholder — nunca commitar URI real
      db: 'meu-banco'

    defaults:                      # vale pra TODAS, salvo override na collection
      deriveFromId: true           # materializa _created a partir do _id (explícito)
      expire: 30d                  # duração humana (ver tabela de unidades)

    collections:
      - orders                     # string -> herda defaults (deriva _created, 30d)
      - logs                       # idem
      - posts                      # idem
      - name: sessions             # override: config própria
        field: lastActivity        #   usa um campo Date que já existe
        expire: 1h                 #   expira em 1h
      - name: trimestral
        field: createdAt
        expire: 3mo                # 3 meses (= 90 dias)
```

- `defaults` é **opcional**. Cada chave (`deriveFromId`, `field`, `expire`/`expireAfterSeconds`) é herdável.
- `collections[]` aceita **`string`** (herda tudo do default) ou **objeto** com override — mesmo padrão de união que o `sync` já usa hoje (consistência de código).
- Por collection, `field` e `deriveFromId` são **mutuamente exclusivos**.

### Precedência (resolução por collection)

Pra cada collection, resolve-se `field`/`deriveFromId` e `expire`:

1. Se a collection define explícito → usa o dela.
2. Senão → herda de `defaults`.
3. Se no fim não tiver **nem** `field` **nem** `deriveFromId` → **erro**, não roda.

## Formato CLI direto

```sh
# deriva _created do _id, 30 dias, em 3 collections
pulsar ttl --uri "mongodb://..." --db meu-banco \
  --collections orders,logs,posts \
  --derive-from-id \
  --expire 30d

# campo Date que já existe, 1 hora
pulsar ttl --uri "mongodb://..." --db meu-banco \
  --collections sessions \
  --field lastActivity \
  --expire 1h

# todas as collections do banco
pulsar ttl --uri "mongodb://..." --db meu-banco --all --derive-from-id --expire 90d
```

| Flag | Papel |
|---|---|
| `--uri <uri>` | conexão Mongo |
| `--db <nome>` | banco alvo |
| `--collections <a,b,c>` | lista separada por vírgula |
| `--all` | todas as collections do banco |
| `--field <nome>` | campo `Date` existente como base do TTL |
| `--derive-from-id` | materializa `_created` a partir do `_id` (explícito) |
| `--expire <dur>` | duração: `30d`, `1h`, `3mo`... (tabela de unidades) |

- No CLI a config é **uniforme** pra todas as collections listadas (a graça é ser rápido). Configs diferentes por collection → use YAML.
- `--field` e `--derive-from-id` são **mutuamente exclusivos**.
- `--collections` e `--all` são **mutuamente exclusivos**.

### Resolução do comando

`pulsar ttl [arquivo.yml]`:

- **com** arquivo posicional → **modo YAML** (granular).
- **sem** arquivo → **modo CLI**, exige: `--uri`, `--db`, `--expire`, (`--field` **ou** `--derive-from-id`), e (`--collections` **ou** `--all`).

## Duração humana → `expireAfterSeconds`

O Mongo só aceita `expireAfterSeconds` (número cru de segundos). O pulsar converte a duração humana pra segundos internamente. Aceita também `expireAfterSeconds` direto (número exato, sem conversão).

| Sufixo | Significado | Segundos |
|---|---|---|
| `s` / `sec` / `seconds` | segundos | 1 |
| `min` / `minutes` | minutos | 60 |
| `h` / `hours` | horas | 3 600 |
| `d` / `days` | dias | 86 400 |
| `w` / `weeks` | semanas | 604 800 |
| `mo` / `months` | meses | 2 592 000 (30 d) |
| `y` / `years` | anos | 31 536 000 (365 d) |

Decisões:

- **`m` sozinho é proibido** (ambíguo entre minuto e mês). Minuto = `min`, mês = `mo`.
- **Mês e ano são aproximados** (mês = 30 d, ano = 365 d), pois `expireAfterSeconds` é fixo. `3mo` = 90 dias exatos, não "3 meses de calendário". Aceitável pra TTL, que já é aproximado (monitor roda ~a cada 60 s).
- Formato aceito: `<número><sufixo>`, ex.: `30d`, `1h`, `3mo`, `90days`. Sem espaço.

## Reaproveitamento de código existente

- `db/conn.ts` — conexão Mongo (mesmo cliente do migrate/sync).
- `functions/getCollections.ts` — resolve lista de collections, incluindo `--all`.
- `utils/parseYml.ts` (Zod) — validação do yml; novo schema `ttlYmlSchema` em `types/parseYml.ts`.
- `utils/customLog.ts` — logs terminal + arquivo.

## Estrutura de arquivos nova (proposta)

```
src/
  commands/
    ttl.ts                 # orquestra o comando: parse, resolve collections, aplica TTL por collection
  core/
    ttl/
      applyTtl.ts          # por collection: (opcional) materializa _created + cria índice TTL
      deriveCreated.ts     # updateMany pipeline { $toDate: "$_id" } idempotente
      parseDuration.ts     # "30d" -> segundos (tabela de unidades)
      resolveTtlEntry.ts   # aplica precedência defaults+override -> { field, expireAfterSeconds }
  types/
    parseYml.ts            # + ttlYmlSchema, TtlYmlOptions, TtlCollectionEntry
    cliOptions.d.ts        # + TtlOptionsCli
  cli.ts                   # + program.command("ttl [file]") com as flags
```

## Erros e validações

- `field` **e** `deriveFromId` juntos (na mesma collection ou flags CLI) → erro.
- Collection sem `field` nem `deriveFromId` resolvidos → erro, não executa nada.
- `expire` com unidade inválida ou `m` sozinho → erro de parse claro.
- `--collections` e `--all` juntos, ou nenhum dos dois → erro.
- Modo CLI sem `--expire` / `--uri` / `--db` → erro.
- Standalone (origem é Replica Set? **não é necessário** — TTL não usa Change Stream; basta conexão normal).

## Testes (contra Mongo real, padrão do projeto em `test/`)

- `parseDuration`: cada unidade, `m` proibido, formato inválido.
- `resolveTtlEntry`: precedência defaults+override; erro quando não resolve.
- `deriveCreated`: materializa `_created` correto (= timestamp do `_id`); idempotência (rodar 2x não reescreve).
- `applyTtl`: cria índice TTL no campo certo com `expireAfterSeconds` certo; campo `Date` existente vs derivado.
- Integração: yml com global + override; CLI uniforme; erro de collection sem campo.
- Comportamento de expiração de fato (insert doc antigo + `expireAfterSeconds:1` + aguarda monitor) — opcional/lento, como já feito na prova.

## Documentação a atualizar

- `CLAUDE.md`: nova seção do comando `ttl` (modos, formato yml, flags CLI, restrição do `_id`, tabela de unidades, campo `_created`).
- Bloco "Comandos úteis" e "Estrutura" do `CLAUDE.md` com os arquivos novos.

## Segurança

Nenhuma URI/credencial real em spec, docs, exemplos ou testes commitados — apenas placeholders (`mongodb://...`) ou os mongos locais (`localhost:27020/27021`). Conferir `git diff --staged` antes de commitar.
