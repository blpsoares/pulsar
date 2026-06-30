> 🌐 **Language / Idioma:** **English** · [Português (Brasil)](./README.pt-BR.md)

# Mongo Pulsar

CLI for syncing data between MongoDB databases. It supports two modes: **migrate** (one-shot snapshot via mongodump/mongorestore) and **sync** (continuous watch via Change Streams).

---

## Installation

### Option 1 — local binary

```sh
bun run bin:dev
```

Compiles and copies the binary to `~/.local/bin/pulsar`.

### Option 2 — Docker

```sh
docker-compose up --build -d
docker exec -it pulsar-dev sh
```

---

## Commands

### `migrate` — one-shot snapshot

Exports collections from the source database via `mongodump` and restores them into the destination via `mongorestore`. Ideal for the initial migration of large volumes.

**Configuration file:**

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
    queryString: '{"status":"active"}' # optional — filter in JSON.stringify format
```

**Usage:**

```sh
pulsar migrate config.yml [options]
```

| Flag | Description | Default |
|---|---|---|
| `-p, --parallel <n>` | Collections exported in parallel | `2` |
| `-r, --maxRetries <n>` | Retries for failed collections | `3` |
| `-a, --all` | Exports every collection in the database | — |

**Example:**

```sh
pulsar migrate config.yml -p 5 -r 10
pulsar migrate config.yml -a
```

**Internal behavior:**
- If the `temp-dump` folder already exists (a previously interrupted run), it resumes from the collections that were not exported yet.
- The `temp-dump` folder is removed at the end.
- Each collection is restored with a `_dump_` prefix and then renamed, avoiding conflicts with existing data.

---

### `sync` — continuous watch

Opens a full cursor on the source database for the initial sync and keeps a Change Stream active to capture inserts, updates, replaces, and deletes in real time.

> **Requirement:** the **source** database must be in a Replica Set (Change Streams do not work in standalone).

**Configuration file:**

```yaml
command:
  sync:
    source:
      uri: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true'
      db: 'source-database'
    destination:
      uri: 'mongodb://localhost:27017'
      db: 'destination-database'
    collections: ['collection-1', 'collection-2']  # or the filtered format — see below
    logging:
      verbose: false   # logs each event in the terminal (insert, update, delete, replace)
      progress: true   # shows a progress bar during the initial dump
```

**Usage:**

```sh
pulsar sync config.yml [options]
```

| Flag | Description | Default |
|---|---|---|
| `-p, --parallel <n>` | Collections processed in parallel | `3` |
| `-a, --all` | Syncs every collection in the database | — |
| `-v, --verbose` | Logs each event in the terminal (overrides `logging.verbose` from the yml) | `false` |

**Examples:**

```sh
pulsar sync config.yml -p 5
pulsar sync config.yml -a
pulsar sync config.yml --verbose
```

---

### Per-collection filters

Collections can have optional filters applied both to the initial dump cursor and to the Change Stream. There are two ways to define them:

**Inline in the yml (native YAML):**

```yaml
collections:
  - users                      # no filter — syncs everything
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

**External JSON file (for large filters):**

```yaml
collections:
  - name: events
    filterFile: ./filters/events.json   # path relative to the CWD
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

> Inline filters and `filterFile` cannot be used together on the same collection.
> Deletes are always propagated regardless of the filter.

---

### Internal behavior of sync

On start (or restart), for each collection:

1. Opens a Change Stream — real-time events are already being captured.
2. Counts the total number of documents (`countDocuments`) to display the progress bar.
3. Runs a full cursor on the source (`find(filter).sort({ _id: -1 })`).
4. For each document, compares the source's SHA-1 hash with `__sync.hash` on the destination:
   - **Document missing on the destination** → `insertOne`
   - **`__sync.hot === true`** → skip (the change stream already updated this doc with a newer version)
   - **Equal hash** → skip (identical document, zero writes)
   - **Different hash** → `updateOne`

This ensures that when you add a new collection and restart the watch, only new or changed documents are processed in the existing collections.

**Progress during the dump:**

```
colA ⟬████████░░⟭ 80% | 8000/10000 | ↷ 7950 skip | ✎ 30 upd | ⊕ 20 ins | ⧖ 00:45
```

**When each collection finishes:**

```
[ SUCCESS ] Collection [ colA ] finished — 10000 docs | 9950 equal | 30 updated | 20 inserted
```

**With `--verbose`, each watch event:**

```
[ INFO ] [orders] insert | _id: 63abc123...
[ INFO ] [orders] update | _id: 63abc124...
[ INFO ] [orders] delete | _id: 63abc125...
```

**Metadata added to documents on the destination:**

```json
{
  "__sync": {
    "hot": true,
    "ts": 1234567890,
    "hash": "sha1-of-the-source-document"
  },
  "origin": "dump | watch:insert | watch:update | watch:replace"
}
```

**Events supported by the Change Stream:**

| Event | Behavior |
|---|---|
| `insert` | Inserts the document on the destination with `origin: watch:insert` |
| `update` | Updates via upsert with `origin: watch:update` |
| `replace` | Replaces the document with `origin: watch:replace` |
| `delete` | Removes the document from the destination |

> **Warning:** deletes that happen while the watch is **off** are not propagated on restart — the cursor only sees documents that exist on the source.

---

## Logs

All events are recorded to file via Winston, regardless of `--verbose`.

| File | Contents |
|---|---|
| `logs/error.log` | Errors only |
| `logs/debug.log` | All events (info, success, warn, error) |

To disable the progress bar (e.g. in environments without a TTY):

```yaml
logging:
  progress: false
```

---

## Local testing with Docker

The repository includes a `docker-compose-test.yml` with two isolated Mongos (mongo-a on port 27020, mongo-b on port 27021) and a sample config at `configs/test-sync.yml`.

```sh
# Start the containers
docker compose -f docker-compose-test.yml up -d

# Initialize the replica set on mongo-a (required for Change Streams)
docker exec mongo-a mongosh --eval "rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]})"

# Run the sync
pulsar sync configs/test-sync.yml

# With verbose
pulsar sync configs/test-sync.yml --verbose
```
