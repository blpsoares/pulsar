# Mongo Pulsar

CLI para sincronização de dados entre bancos MongoDB. Suporta dois modos: **migrate** (snapshot único via mongodump/mongorestore) e **sync** (watch contínuo via Change Streams).

---

## Instalação

### Opção 1 — binário local

```sh
bun run bin:dev
```

Compila e copia o binário para `~/.local/bin/pulsar`.

### Opção 2 — Docker

```sh
docker-compose up --build -d
docker exec -it pulsar-dev sh
```

---

## Comandos

### `migrate` — snapshot único

Exporta collections do banco de origem via `mongodump` e restaura no destino via `mongorestore`. Ideal para a migração inicial de grandes volumes.

**Arquivo de configuração:**

```yaml
command:
  migrate:
    source:
      uri: 'mongodb://localhost:27017'
      db: 'source-database'
    destination:
      uri: 'mongodb://localhost:27017'
      db: 'destination-database'
    collections: ['collection-1', 'collection-2']
    queryString: '{"status":"active"}' # opcional — filtro em formato JSON.stringify
```

**Uso:**

```sh
pulsar migrate config.yml [opções]
```

| Flag | Descrição | Padrão |
|---|---|---|
| `-p, --parallel <n>` | Collections exportadas em paralelo | `2` |
| `-r, --maxRetries <n>` | Tentativas em collections com falha | `3` |
| `-a, --all` | Exporta todas as collections do banco | — |

**Exemplo:**

```sh
pulsar migrate config.yml -p 5 -r 10
pulsar migrate config.yml -a
```

**Comportamento interno:**
- Se a pasta `temp-dump` já existir (processo interrompido anteriormente), retoma a partir das collections não exportadas.
- A pasta `temp-dump` é removida ao final.
- Cada collection é restaurada com o prefixo `_dump_` e depois renomeada, evitando conflito com dados existentes.

---

### `sync` — watch contínuo

Abre um cursor completo no banco de origem para sincronização inicial e mantém um Change Stream ativo para capturar inserções, atualizações, substituições e deleções em tempo real.

> **Requisito:** o banco de **origem** precisa estar em Replica Set (Change Streams não funcionam em standalone).

**Arquivo de configuração:**

```yaml
command:
  sync:
    source:
      uri: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true'
      db: 'source-database'
    destination:
      uri: 'mongodb://localhost:27017'
      db: 'destination-database'
    collections: ['collection-1', 'collection-2']  # ou formato com filtro — ver abaixo
    logging:
      verbose: false   # loga cada evento no terminal (insert, update, delete, replace)
      progress: true   # exibe barra de progresso durante o dump inicial
```

**Uso:**

```sh
pulsar sync config.yml [opções]
```

| Flag | Descrição | Padrão |
|---|---|---|
| `-p, --parallel <n>` | Collections processadas em paralelo | `3` |
| `-a, --all` | Sincroniza todas as collections do banco | — |
| `-v, --verbose` | Loga cada evento no terminal (sobrescreve `logging.verbose` do yml) | `false` |

**Exemplos:**

```sh
pulsar sync config.yml -p 5
pulsar sync config.yml -a
pulsar sync config.yml --verbose
```

---

### Filtros por collection

Collections podem ter filtros opcionais aplicados tanto no cursor do dump inicial quanto no Change Stream. Duas formas de definir:

**Inline no yml (YAML nativo):**

```yaml
collections:
  - users                      # sem filtro — sincroniza tudo
  - name: orders
    filter:
      status: "active"
  - name: logs
    filter:
      level:
        $in: ["error", "warn"]
      createdAt:
        $gte: "2024-01-01"
```

**Arquivo JSON externo (para filtros grandes):**

```yaml
collections:
  - name: events
    filterFile: ./filters/events.json   # path relativo ao CWD
```

`./filters/events.json`:
```json
{
  "$and": [
    { "status": "published" },
    { "deletedAt": { "$exists": false } }
  ]
}
```

> Filtros inline e `filterFile` não podem ser usados juntos na mesma collection.
> Deletes sempre são propagados independente do filtro.

---

### Comportamento interno do sync

Ao iniciar (ou reiniciar), para cada collection:

1. Abre um Change Stream — eventos em tempo real já estão sendo capturados.
2. Conta o total de documentos (`countDocuments`) para exibir a barra de progresso.
3. Roda um cursor completo no source (`find(filter).sort({ _id: -1 })`).
4. Para cada documento, compara o hash SHA-1 do source com `__sync.hash` no destino:
   - **Doc ausente no destino** → `insertOne`
   - **`__sync.hot === true`** → pula (change stream já atualizou este doc com versão mais recente)
   - **Hash igual** → pula (documento idêntico, zero writes)
   - **Hash diferente** → `updateOne`

Isso garante que ao adicionar uma nova collection e reiniciar o watch, apenas documentos novos ou alterados são processados nas collections existentes.

**Progresso durante o dump:**

```
colA ⟬████████░░⟭ 80% | 8000/10000 | ↷ 7950 skip | ✎ 30 upd | ⊕ 20 ins | ⧖ 00:45
```

**Ao finalizar cada collection:**

```
[ SUCCESS ] Collection [ colA ] concluída — 10000 docs | 9950 iguais | 30 atualizados | 20 inseridos
```

**Com `--verbose`, cada evento do watch:**

```
[ INFO ] [orders] insert | _id: 63abc123...
[ INFO ] [orders] update | _id: 63abc124...
[ INFO ] [orders] delete | _id: 63abc125...
```

**Metadados adicionados aos documentos no destino:**

```json
{
  "__sync": {
    "hot": true,
    "ts": 1234567890,
    "hash": "sha1-do-documento-origem"
  },
  "origin": "dump | watch:insert | watch:update | watch:replace"
}
```

**Eventos suportados pelo Change Stream:**

| Evento | Comportamento |
|---|---|
| `insert` | Insere o documento no destino com `origin: watch:insert` |
| `update` | Atualiza via upsert com `origin: watch:update` |
| `replace` | Substitui o documento com `origin: watch:replace` |
| `delete` | Remove o documento do destino |

> **Atenção:** deleções que ocorrem enquanto o watch está **desligado** não são propagadas no reinício — o cursor vê apenas documentos que existem no source.

---

## Logs

Todos os eventos são registrados em arquivo via Winston, independente de `--verbose`.

| Arquivo | Conteúdo |
|---|---|
| `logs/error.log` | Apenas erros |
| `logs/debug.log` | Todos os eventos (info, success, warn, error) |

Para desabilitar a barra de progresso (ex.: em ambientes sem TTY):

```yaml
logging:
  progress: false
```

---

## Teste local com Docker

O repositório inclui um `docker-compose-test.yml` com dois Mongos isolados (mongo-a na porta 27020, mongo-b na porta 27021) e um config de exemplo em `configs/test-sync.yml`.

```sh
# Subir os containers
docker compose -f docker-compose-test.yml up -d

# Inicializar o replica set do mongo-a (necessário para Change Streams)
docker exec mongo-a mongosh --eval "rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]})"

# Rodar o sync
pulsar sync configs/test-sync.yml

# Com verbose
pulsar sync configs/test-sync.yml --verbose
```
