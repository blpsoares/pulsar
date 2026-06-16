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
    collections: ['collection-1', 'collection-2']
```

**Uso:**

```sh
pulsar sync config.yml [opções]
```

| Flag | Descrição | Padrão |
|---|---|---|
| `-p, --parallel <n>` | Collections processadas em paralelo | `3` |
| `-a, --all` | Sincroniza todas as collections do banco | — |

**Exemplo:**

```sh
pulsar sync config.yml -p 5
pulsar sync config.yml -a
```

**Comportamento interno:**

Ao iniciar (ou reiniciar), para cada collection:

1. Abre um Change Stream para capturar eventos em tempo real.
2. Roda um cursor completo no source (`find().sort({ _id: -1 })`).
3. Para cada documento do cursor, compara o hash do source com `__sync.hash` no destino:
   - **Hash igual** → documento idêntico, pula sem nenhuma escrita.
   - **Hash diferente** → atualiza o documento no destino.
   - **Documento ausente** → insere no destino.

Isso garante que ao adicionar uma nova collection e reiniciar o watch, apenas documentos novos ou alterados são processados nas collections existentes.

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

## Teste local com Docker

O repositório inclui um `docker-compose-test.yml` com dois Mongos isolados (mongo-a na porta 27020, mongo-b na porta 27021) e um config de exemplo em `configs/test-sync.yml`.

```sh
# Subir os containers
docker compose -f docker-compose-test.yml up -d

# Inicializar o replica set do mongo-a (necessário para Change Streams)
docker exec mongo-a mongosh --eval "rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]})"

# Rodar o sync
pulsar sync configs/test-sync.yml
```

---

## Logs

| Arquivo | Conteúdo |
|---|---|
| `logs/error.log` | Apenas erros |
| `logs/debug.log` | Todos os eventos (info, success, warn, error) |
