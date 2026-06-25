# Sync — `copyIndexes`: replicar índices da origem no destino

**Data:** 2026-06-25
**Status:** aprovado, pronto p/ implementação

## Problema

O `sync` copia dados **documento a documento** (`insertOne`/`updateOne` via cursor + change stream). Isso replica só os dados: os índices da origem (fora o `_id_`, que toda collection tem) **não viajam**. Quem usa `sync` fica com o destino sem os índices secundários da origem.

(O `migrate`, que usa `mongodump`/`mongorestore`, já traz índices — o `mongorestore` os restaura do `.metadata.json`. O problema é só do `sync`.)

## Objetivo

Uma flag booleana opcional no yml do sync (`copyIndexes`, default `false`) que, quando ligada, **garante** os índices da origem no destino — criando **só os que faltam**, sem reconstruir o que já existe. Cenário-alvo concreto: um banco grande **já migrado** que precisa apenas completar índices ausentes, sem re-dumpar nem reconstruir índices existentes.

## Decisões (resolvidas)

- **Nome da flag:** `copyIndexes`.
- **Granularidade:** global na sync (vale p/ todas as collections). Override por collection fica como porta aberta (não entra agora — YAGNI).
- **Retry:** **não** retenta `createIndex` no mesmo run. O retry natural é o **próximo startup**, que re-faz o diff e pega só o que ainda falta. Um blip de rede não trava o sync.
- **Falha nunca aborta o sync.** O sync de dados é o trabalho principal; cópia de índice é best-effort, com relatório honesto.

## Comportamento

### Verificação de existência (diff por assinatura)

Em vez de mandar `createIndex` pra tudo e contar com o no-op do Mongo, faz-se um **diff**:

1. `listIndexes()` na **origem** → índices que deveriam existir, **menos o `_id_`**.
2. `listIndexes()` no **destino** → normaliza cada índice numa **assinatura** (`key` + opções relevantes: `unique`, `sparse`, `partialFilterExpression`, `collation`, `expireAfterSeconds`, `wildcardProjection`, `weights`/`default_language` p/ text, etc.).
3. Cria no destino **só os índices da origem cuja assinatura não existe** lá.

Vantagens sobre confiar no no-op nativo: (a) num banco já migrado, a maioria das collections não recebe nenhuma chamada de escrita — é só leitura de metadados, barato; (b) evita criar um índice equivalente porém com **nome diferente** (que viraria duplicado).

**Backstop:** cada índice é criado usando o **nome original da origem**. Assim, mesmo que a normalização da assinatura erre (ex.: ordem de campos no `partialFilterExpression`), o próprio Mongo é a 2ª rede de proteção — `createIndex` com nome+spec idênticos é **no-op nativo**, não reconstrói.

### Quando rodar — ordenado pela natureza da collection

Sempre que o sync inicia (com a flag on), mas ordenado:

| Caminho da collection | Quando cria o índice | Por quê |
|---|---|---|
| **Dumpa** (1ª sync) | **depois** do dump concluir (`markDumpCompleted` ok) | build em lote único é muito mais rápido que manter índice a cada insert — é o que o `mongorestore` faz |
| **Resume** (token) / **já migrada** | no startup, se faltar | dados já estão lá; só completa o que falta |

No cenário-alvo (banco já migrado), tudo cai no segundo caso: completa índices faltantes, sem re-dump nem reconstrução.

### Matriz de falhas (todas contidas, nenhuma aborta)

| Caso | Tratamento |
|---|---|
| `listIndexes` na **origem** falha (perm, coll sumiu) | pula a collection, loga, conta em `failed` |
| `listIndexes` no **destino** falha | **não cria nada** (seguro), loga |
| Conflito de nome (mesmo nome, spec diferente) | loga, `failed++`, segue |
| Índice equivalente com nome diferente | diff por assinatura detecta → pula (não duplica) |
| TTL/unique da origem ausente no destino | criado normal |
| `unique` que viola dados existentes no destino | build rejeita → loga, `failed++`, segue |
| Text index divergente (1 por coll) | conflito → loga, `failed++`, segue |
| Conexão cai no meio do `createIndex` | capturado por-índice → `failed++`, segue (próximo startup completa) |
| `_id_` | sempre pulado |
| Flag off | caminho inteiro não roda (zero overhead) |

## Componentes

### `src/core/sync/copyIndexes.ts` (novo)

Lógica pura e isolada.

```ts
export type IndexCopyResult = {
  created: number;
  skipped: number;        // já existiam (assinatura batia)
  failed: { name: string; reason: string }[];
  createdNames: string[]; // p/ log verbose
};

export async function ensureCollectionIndexes(
  srcCol: Collection,
  destCol: Collection,
): Promise<IndexCopyResult>;
```

- Lê `srcCol.listIndexes()`, descarta `_id_`.
- Lê `destCol.listIndexes()`, monta `Set` de assinaturas normalizadas.
- Pra cada índice da origem ausente no destino: extrai `key` + opções (descarta `v`, `ns`, `key`, `name` do objeto de opções), chama `destCol.createIndex(key, { name, ...options })`.
- `try/catch` por índice → erro vira entrada em `failed`, nunca propaga.
- `listIndexes` da origem falhando → propaga UM erro pro chamador marcar a collection inteira como falha. `listIndexes` do destino falhando → trata como "não consigo diferenciar" e retorna sem criar (resultado com motivo).

Normalização da assinatura: JSON canônico (chaves ordenadas) de `{ key, unique, sparse, partialFilterExpression, collation, expireAfterSeconds, wildcardProjection, weights, default_language, text/2dsphere specifics }`. Campos ausentes omitidos.

### `src/core/sync/engine.ts`

- `SyncEngineOptions` ganha `copyIndexes?: boolean` (default `false`).
- Novos contadores no engine (espelham `docsDumped`/`failedDumps`):
  - `indexesCreated = 0`
  - `indexesSkipped = 0`
  - `indexFailures: { coll: string; name: string; reason: string }[] = []`
  - opcional p/ log por collection: `indexPerColl: Map<string, { created: number; skipped: number; failed: number }>`
- **Collection que dumpa:** após `markDumpCompleted` (no `ok` do `runDump`), se `copyIndexes`, chama `ensureCollectionIndexes(route.srcCol, route.destCol)` e agrega contadores + loga a linha por collection.
- **Collection que resume / já migrada:** no `start()`, pras collections que **não** vão dumpar (`!needsDump`), se `copyIndexes`, roda `ensureCollectionIndexes` (throttled pelo mesmo Bottleneck `parallel`, p/ não martelar o Atlas) e agrega.
- Helper privado `private async copyIndexesFor(col)` centraliza a chamada + agregação + log, usado nos dois caminhos.

### `src/types/parseYml.ts`

`syncYmlSchema.command.sync` ganha `copyIndexes: z.boolean().optional()`. Tipo exportado segue de `z.infer`.

### `src/commands/sync.ts`

- Lê `options.command.sync.copyIndexes ?? false` e passa pro `SyncEngine`.
- Log inicial (linha de `Performance:`) inclui `| copyIndexes=on` quando ligado.
- Ao montar o painel, passa os contadores de índice pro `renderClosingPanel`.

### `src/utils/progressManager.ts`

`renderClosingPanel` ganha campos opcionais:
```ts
indexes?: { created: number; skipped: number; failed: { coll: string; name: string }[] };
```
Quando presente (flag on), adiciona uma linha:
```
ÍNDICES  criados: 4 · já existiam: 15 · falharam: 1 (logs)
```
Quando ausente (flag off), a linha não aparece.

## Log — por collection + total

**Por collection** (conforme cada caminho termina), nível info:
```
[orders]  3 índices criados, 5 já existiam
[users]   0 criados, 8 já existiam
[logs]    1 criado, 2 já existiam, 1 FALHOU (conflito: idx_status)
```
Em `--verbose`: ainda loga cada índice criado individualmente (`nome + key`).

**Total no painel final** (a tabela do terminal): linha `ÍNDICES` agregando todas as collections. Mesmos números também no `logger.info` do "SYNC PRONTO".

## Testes (`test/`, contra Mongo real)

`test/copyIndexes.test.ts` (lógica pura `ensureCollectionIndexes`):

- origem com 2 índices secundários, destino vazio → cria os 2, `skipped=0`.
- destino já com os mesmos índices → `created=0`, `skipped=2` (diff pula, nenhuma escrita).
- índice equivalente com **nome diferente** no destino → pula (não duplica).
- conflito de nome (mesmo nome, spec diferente) → entra em `failed`, não propaga.
- índice **unique** e índice **partial** → spec replicado fiel (lê de volta e compara).
- índice **TTL** (`expireAfterSeconds`) na origem → replicado.
- só `_id_` na origem → no-op (`created=0`, `skipped=0`).
- `listIndexes` da origem falhando → propaga (engine marca a collection como falha).

Integração no engine (estender suíte existente): com `copyIndexes: true`, após o dump as collections de destino têm os índices da origem; com a flag off, não têm (comportamento atual preservado).

## Fora de escopo (YAGNI)

- Override `copyIndexes` por collection (porta aberta: somar campo no `syncCollectionEntrySchema` depois).
- Retry de `createIndex` no mesmo run (coberto pelo re-diff do próximo startup).
- Drop de índices que existem no destino mas **não** na origem (só **adiciona**, nunca remove).
- Cobertura do `migrate` (já traz índices via `mongorestore`).
