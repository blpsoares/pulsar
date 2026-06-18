# ADR 0001 — Dump inicial em lote (batch) no `sync`

**Status:** Aceito e implementado
**Data:** 2026-06-18
**Componente:** `src/core/sync/dumpEvent.ts`

---

## Contexto / problema

O comando `sync` faz um dump inicial (snapshot) de cada collection antes/durante
o watch via Change Stream. A implementação original processava **um documento
por vez**: para cada doc do cursor da origem, fazia

1. um `findOne` no destino (lendo `__sync.hot` e `__sync.hash`), e
2. condicionalmente um `insertOne`/`updateOne`.

Isso gera **2 round-trips por documento** (1 leitura + até 1 escrita), em série.

### Sintomas observados em produção (VM contra Atlas remoto)

- A collection `simulacoesPlanejamentoGeohashes` (~506k docs) no restart estava
  em **40% após 34 min** → projeção de **~85 min** só para re-verificar (com
  praticamente tudo sendo "skip", pois os dados já estavam no destino).
- **Timeouts de conexão** (`secureConnect timed out`, `Server selection timed
  out`) derrubaram a aplicação. Causa: pressão de conexão — `-p 5` dumps
  simultâneos, cada um disparando 1 `findOne` por doc, somados a 54 change
  streams, saturaram a rede contra o Atlas.

### A dúvida central

O skip por hash economiza **writes**, mas **não economiza reads**: um restart
ainda faz 1 `findOne` por documento. Logo, "reiniciar leva o mesmo tempo, mesmo
pulando tudo". Confirmado — o gargalo é o número de round-trips, não os writes.

---

## Opções consideradas

### A) Manter 1-a-1 (status quo)

- `findOne` + write por documento, em série.
- Simples, janela read→write mínima.
- **N round-trips de leitura** por collection.

### B) Processar em lote (batch) — **escolhida**

Para cada página de `batchSize` documentos do cursor:

1. **Uma** leitura no destino: `find({ _id: { $in: [...ids] } })` projetando só
   `__sync.hot`/`__sync.hash` → mapa em memória.
2. Decide doc a doc, **com a mesma regra** do modo 1-a-1 (ausente → insert; hot
   ou hash igual → skip; hash diferente → update).
3. **Um** `bulkWrite({ ordered: false })` com as operações necessárias.

→ `ceil(N / batchSize)` round-trips de leitura por collection (ex.: 500× menos
com `batchSize=500`).

---

## Provas / benchmark

### Metodologia

Script: `scripts/bench-dump.ts` (reprodutível). Origem e destino em containers
locais (mesma máquina) para isolar **a diferença entre as estratégias**. As duas
estratégias replicam fielmente a lógica real (hash SHA-1 via `BSON.serialize`,
checagem de `__sync.hot`/`__sync.hash`).

Dois cenários:

- **COLD** — destino vazio (1ª sync, tudo insert).
- **WARM** — destino já populado (restart, tudo skip). _Este é o cenário da
  dúvida central._

Parâmetros: `N = 100.000` documentos (~1 KB cada), `batchSize = 500`.

> **Caveat honesto:** localhost tem latência ~0,2 ms/chamada; o Atlas remoto tem
> ~1–10 ms+. Como o batch faz ~500× menos chamadas e a estratégia atual é
> **latency-bound** em rede remota, os ganhos medidos abaixo são um **piso** — na
> VM o ganho é maior.

### Resultado (medição limpa, processo único)

| Estratégia | Tempo | Reads (round-trips) | Writes |
|---|---:|---:|---:|
| atual COLD (insert)        | **242,6 s** | 100.000 | 100.000 |
| atual WARM (skip/restart)  | **106,4 s** | 100.000 | 0 |
| batch COLD (insert)        | **8,2 s**   | 200     | 200 |
| batch WARM (skip/restart)  | **5,0 s**   | 200     | 0 |

### Análise

- **Velocidade (medida):** COLD ~30× mais rápido (242,6/8,2); WARM ~21× mais
  rápido (106,4/5,0).
- **Round-trips (determinístico):** 100.000 → 200 = **500× menos** chamadas de
  rede. É isso que ataca a causa-raiz dos timeouts.
- **Consistência (empírica):** nos dois WARM, `writes = 0`. O batch pulou
  **exatamente os mesmos** documentos que o modo 1-a-1, sem nenhum write
  espúrio. O risco de "sobrescrever dado bom" não se materializou.

### Projeção para `simulacoesPlanejamentoGeohashes` (506k, restart/skip)

| Cenário | Tempo estimado |
|---|---:|
| Atual — observado na VM | ~85 min |
| Atual — localhost (piso) | ~9 min |
| Batch — localhost (piso) | ~25 s |
| **Batch — na VM (conservador, 20×)** | **~4 min** |
| Batch — na VM (realista, latency-bound) | provavelmente < 2 min |

---

## Decisão (tabela ponderada)

Pesos definidos pelo caso de uso (daemon de sync, backfill grande, Atlas remoto):

| Critério | Peso | Atual | Batch |
|---|---:|---:|---:|
| Consistência de dados (medido: writes idênticos) | 30 | 4 → 24 | 4 → 24 |
| Confiabilidade operacional (500× menos pressão de conexão) | 25 | 2 → 10 | 5 → 25 |
| Velocidade (medido: 21–30×) | 20 | 1 → 4 | 5 → 20 |
| Uso de recursos | 15 | 3 → 9 | 4 → 12 |
| Simplicidade / risco de bug | 10 | 5 → 10 | 3 → 6 |
| **TOTAL** | **100** | **57** | **87** |

**87 × 57 a favor do batch.** O ganho vem de confiabilidade + velocidade;
consistência **empatou na prática medida**. O risco do batch é de
implementação (mitigável), enquanto o risco do status quo é recorrente e **já
materializado** (a VM caiu).

---

## Riscos e mitigações

| Risco | Mitigação aplicada |
|---|---|
| Falha parcial de lote mascarando docs | `bulkWrite({ ordered: false })` — os demais docs do lote são gravados mesmo se um falhar |
| Janela da race: doc fica `hot` (change stream) entre a leitura do lote e a escrita | Filtro `__sync.hot: { $ne: true }` no `updateOne` — não pisa na versão ao vivo |
| Limite de 16 MB / ~100k ops por comando | `batchSize` configurável (default 500); o driver ainda fatia internamente |
| Uso de memória sobe (N docs + N resultados em RAM × paralelismo) | `batchSize` moderado; cuidado ao combinar lote grande com `parallel` alto |

> **Importante:** um batch **mal feito** (sem `ordered:false` + sem o filtro
> `hot:{$ne:true}`) pontua igual ao status quo (57) e ainda piora a
> consistência. O ganho **depende** dessas duas mitigações.

---

## Parâmetros configuráveis

Precedência: **flag CLI > yml > default**.

| Parâmetro | CLI | yml (`command.sync.performance`) | Default |
|---|---|---|---|
| Collections em paralelo no dump | `-p, --parallel <n>` | `parallel` | `3` |
| Tamanho do lote (find $in + bulkWrite) | `-b, --batch <n>` | `batchSize` | `500` |

```yaml
command:
  sync:
    # ...
    performance:
      parallel: 5
      batchSize: 500
```

```sh
bun run src/cli.ts sync ads-staging.yml -p 5 -b 500 --verbose
```

---

## Como reproduzir o benchmark

```sh
docker run -d --name pulsar-bench -p 27099:27017 mongo:7
BENCH_URI="mongodb://localhost:27099" BENCH_N=100000 BENCH_PAGE=500 \
  bun run scripts/bench-dump.ts
```
