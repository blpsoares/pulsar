# `sync` architecture — full picture

> Reference document for the architecture of the `sync` mode (continuous watch).
> For the visual diagram, open `docs/arquitetura-sync.excalidraw` in
> [excalidraw.com](https://excalidraw.com).

`sync` keeps a **destination** database (replica) up to date with a **source**
database (production), on two fronts that run **together in the same process**:

1. **Initial dump** — copies what already exists (once per collection).
2. **Continuous watch** — replicates every new change in real time.

The watch is **turned on BEFORE** the dump starts — so, while the copy scans the
old pages, the new changes are already being captured and nothing slips through
the gap.

Hard rule: **the source is read-only; every write happens on the destination.**

---

## 1. Connections to Atlas

- **1 listener connection** (a single `db.watch` over the whole database).
- **~`parallel` connections** that cycle through the dumps (default 3–5).

Why only 1 listener: each change stream is a *long-poll* that holds a connection
forever. One stream per collection (e.g. 50) would hold 50 connections + the dump
ones → blows past the shared Atlas limit. Hence: **a single stream**, sliced to
the N collections via `$match` on `ns.coll`.

Code: `core/sync/engine.ts` (`openStream`), `core/sync/dbWatchPipeline.ts`.

---

## 2. Half 1 — the initial dump

For each collection, in parallel (capped by `parallel`):

1. Opens a **cursor** on the source by **descending** `_id` (`find().sort({_id:-1})`).
2. Reads in batches (`batchSize`, default 500). For each doc, decides by looking at
   the **destination**:
   - does not exist → **insert**
   - exists and **hash equal** → **skip** (zero writes)
   - exists and **hash different** → **update**
   - exists and `__sync.hot === true` → **skip** (the live watch version wins)
3. On each batch, writes the **frontier** (`dumpCursorId` = smallest `_id` already
   processed) to the destination's `__sync`, ~every 5s.
4. When it finishes **for real** → stamps `dumpCompletedAt` and **deletes** the
   frontier.

The re-dump is **idempotent**: it inserts what's missing, skips what's already equal.

Code: `core/sync/dumpEvent.ts` (`dumpCollections`, `processBatch`),
`core/sync/writeDoc.ts`, `core/sync/syncState.ts` (`saveDumpProgress`,
`markDumpCompleted`).

### 2.1 Reconciliation guard (anti-truncation)

A long-lived cursor against a remote/shared Atlas may **end early WITHOUT throwing
an error** (node down/failover, dead cursor → the driver sometimes ends the
`for await` as if it were a natural end). The old code treated "the loop ended" as
"I read everything" and stamped `dumpCompletedAt` with a partial copy —
**silent data loss**.

The guard: before marking complete, it counts
`countDocuments({_id: {$lt: frontier}})`. If something remains below the frontier,
the scan **did not** finish → it reopens from the frontier (or, once retries are
exhausted, fails loudly and the collection enters `failedDumps` to be re-dumped on
the next restart). It **never** marks a partial as complete. Because the check uses
`_id < frontier`, live inserts (which have a higher `_id`) do not produce a false
positive.

Code: `core/sync/dumpEvent.ts` ("RECONCILIATION GUARD" block).
Tests: `test/dumpReconcile.test.ts`.

---

## 3. Half 2 — the continuous watch

1. **One** `db.watch` on the database, sliced to the N collections.
2. The event is just a **trigger**: the stream is opened **without the document**
   (no `updateLookup`, with a `$project` removing the `fullDocument`). Only
   `ns.coll` and `_id` matter. → **Immune to the change stream's 16MB limit**: the
   event never carries the doc, only the ~12-byte `_id`.
3. The `_id`s land in a **`ChangeBuffer`**, deduplicated per collection.
4. Every `flushIntervalMs` (~1s), the **`flush`** drains the buffer and **re-fetches**
   the docs on the source (`find({_id: {$in: [...]}})`) and writes them to the
   destination. A doc missing from the re-fetch = deletion → `deleteOne`.
5. **Backpressure**: it consumes the stream with `for await`, **awaiting** each
   write before pulling the next event. Memory pinned to ~1 batch (this killed an
   old OOM from the former `.on('change')` fire-and-forget).

Code: `core/sync/engine.ts` (`pump`, `flush`), `core/sync/changeBuffer.ts`,
`core/sync/writeDoc.ts` (`writeDocToDest`).

---

## 4. The resume token

- Every change stream delivers, on each event (and even when idle, via the
  *post-batch resume token*), a **resume token**: an **opaque bookmark into Mongo's
  oplog** — "I've already processed up to here".
- Since the stream is **a single one** (whole database), there is **ONE global
  token**, saved on the destination in `__sync`, doc `id: "__pulsar_db__"`, field
  `resumeToken`. Updated ~every 5s by the `ResumeTokenCheckpointer`.
- **Critical:** it saves the token of the **last batch already WRITTEN**
  (`lastFlushedToken`), not that of the last event seen → the token only advances
  once the write is guaranteed. A `kill -9` loses at most ~5s, re-applied
  idempotently.
- **Resume:** on restart, it reopens `db.watch` with **`startAfter: <token>`**. The
  oplog **redelivers** everything that changed while offline
  (insert/update/**delete**) within seconds — without re-scanning.
- **Failure (286):** if the token is too old (oplog rolled over → `286
  ChangeStreamHistoryLost`), there's no way to resume → **`forceDumpAll`**: it
  re-dumps everything. This is the tradeoff of a single global token.

Code: `core/sync/resumeCheckpointer.ts`, `core/sync/syncState.ts`
(`loadDbResumeToken`, `saveDbResumeToken`), `core/sync/restartDecision.ts`
(`isHistoryLostError`).

---

## 5. The TWO bookmarks (don't mix them up)

| | What it marks | Where it lives | Scope |
|---|---|---|---|
| **`dumpCursorId`** | how far the **initial copy** got | `__sync`, the collection's doc | **per collection** |
| **`resumeToken`** | how far the **live watch** got in the oplog | `__sync`, doc `__pulsar_db__` | **global (just 1)** |

The first resumes an **incomplete dump**. The second resumes **real time** without
re-scanning. They are independent.

---

## 6. Restart decision (per collection)

`decideStartupAction` (`core/sync/restartDecision.ts`):

- **RESUMES** (skips the dump) if: it already had `dumpCompletedAt` **and** a global
  token exists → reopens the watch by the token; the oplog covers what changed
  offline.
- **RE-DUMPS** if: it never completed, there's no token, or `--full`.
- If the global token expired (286) → `forceDumpAll` forces a dump of **all**.

---

## 7. Where the state lives

Two places, different purposes:

**(A) The `__sync` collection** = **orchestration** state.
- 1 doc per collection: `{ id, dumpCompletedAt, dumpCursorId, dumpProgressAt }`
- 1 global doc: `{ id: "__pulsar_db__", resumeToken, tokenUpdatedAt }`

**(B) The `__sync` EMBEDDED in each replicated doc** = **per-document** metadata:
`{ __sync: { hot, ts, hash }, origin, __migratedAt }`.
- `hash` — decides skip/update on re-dump (identical doc → don't rewrite).
- `hot` — race protection: the watch touched the doc during the dump → don't
  overwrite it with the old version.
- `origin` — informational (`dump | watch:insert | ...`).
- `__migratedAt` — TTL anchor (when the doc entered the replica; immutable).

Design discussion: centralizing (B) into a separate collection **does not** pay off
(it would double storage with an `_id → hash` index the size of the source + a
lookup per doc). What truly makes sense in (B) is `hot` and `__migratedAt`; `hash`
and `origin` are candidates for removal if you want cleaner docs (at the cost of
re-dump writing more). (A) is correct where it is.

---

## 8. Views and indexes (off the sync path)

- **Indexes** (`copyIndexes: true`): signature diff source×destination, creates only
  the missing ones. Whoever dumps creates them after the dump; whoever resumes
  creates them at startup. Code: `core/sync/copyIndexes.ts`.
- **Views** (`copyViews: true | [names]`): views are **metadata** (`viewOn` +
  `pipeline`), not data. They run **in parallel** with the dump (they don't depend
  on data; Mongo will create a view even over a nonexistent collection). Equal →
  skip; different → save the old one to `<name>__pulsar_bkp` and recreate it
  identical to the source; missing → create. **Writes only to the destination.**
  Code: `core/sync/copyViews.ts`.

Both are **contained**: an index/view failure logs and moves on, doesn't bring down
the sync, and is retried on the next startup.

---

## 9. Guardrails (summary)

1. **Reconciliation guard** — doesn't mark a dump complete without checking the frontier.
2. **Transient retry** — a network error during the dump → backoff and resume from the frontier.
3. **Backpressure** — waits for the write before the next event (anti-OOM).
4. **Race (`hot`)** — the live version wins over the old dump version.
5. **Token only advances after a write** (`lastFlushedToken`).
6. **Graceful shutdown** — SIGINT/SIGTERM flush the token + frontiers.
7. **A single stream** — doesn't saturate Atlas.
8. **286 detector** — expired token → re-dumps instead of faking a resume.
9. **Prod read-only** — every write only on the destination.
10. **copyViews/copyIndexes contained** — one failure doesn't bring down the sync.

---

## 10. End-to-end example

Scenario: source with the `orders` collection (117 docs) and an `active_orders`
view (`viewOn: orders`). Empty destination. `copyIndexes: true`, `copyViews: true`.

### Boot 1 — database from scratch

1. **Loads the token** from the destination's `__sync` → doesn't exist (new database).
2. **Opens the `db.watch`** fresh (no `startAfter`). From here on, every change on
   the source is already captured in the `ChangeBuffer`.
3. **Turns on the checkpointer** (saves the token every ~5s) and fires the
   **`copyViews` in parallel**: creates the `active_orders` view on the destination.
4. **Decides per collection:** `orders` has no `dumpCompletedAt` → **DUMP**.
5. **Dump of `orders`:** cursor `_id:-1`, batches of 500.
   - For each doc: doesn't exist on the destination → **insert** (with `__sync.hash`,
     `origin: dump`, `__migratedAt`).
   - On each batch: writes `dumpCursorId` to `__sync`.
   - **Guard:** at the end of the cursor, `countDocuments({_id < frontier}) == 0` →
     complete scan → moves on.
6. **Stamps `dumpCompletedAt`** for `orders` and **deletes the frontier**.
7. **Creates the indexes** for `orders` (batch build, post-dump).
8. **Seeds the global token** with the stream's current position and checkpoints.
9. Result: destination with 117 docs, `active_orders` view resolving, indexes in
   place. The process now lives in the **watch**.

### In production — a live change

1. Someone updates a doc in `orders` on the source.
2. The `db.watch` emits a **trigger** (only `ns.coll` + `_id`, no doc).
3. The `_id` enters the `ChangeBuffer`.
4. On the next `flush` (~1s): re-fetches the doc on the source
   (`find({_id: {$in:[id]}})`) and does an `update` on the destination, marking
   `__sync.hot` and preserving `__migratedAt`.
5. The `lastFlushedToken` advances; ~5s later the checkpointer persists the token.

### Boot 2 — restart after 10 min offline

1. **Loads the token** → exists.
2. **Opens the `db.watch` with `startAfter: token`** → the oplog **redelivers** the
   10 min of changes (inserts/updates/**deletes**) within seconds.
3. **Decides per collection:** `orders` has `dumpCompletedAt` + token → **RESUMES**
   (skips the dump). `copyViews`/`copyIndexes` run and find everything equal → skip.
4. Within seconds the replica is up to date, **without re-scanning** 117 docs.

### Failure case — cursor truncated during the dump (boot from scratch)

1. During the dump of a large collection, the cursor **ends early** (Atlas failover)
   without throwing, at frontier `_id = X`.
2. **Guard:** `countDocuments({_id < X})` returns > 0 → it's **not** complete.
3. Reopens the cursor at `_id < X` and continues. (If it exhausts the retries, it
   fails loudly → `failedDumps` → re-dumps on the next restart.)
4. `dumpCompletedAt` is **only** stamped when the guard sees 0 docs below the
   frontier. It never marks a partial as complete.

### Failure case — expired token (286)

1. Restart after a long time offline; the oplog already rolled over and discarded
   the position.
2. `db.watch` with `startAfter` fails with `286 ChangeStreamHistoryLost`.
3. `forceDumpAll`: all collections go back to the **dump** path (re-syncs
   everything), because the global position was lost.
</content>
</invoke>
