# Design: catalog, compiled-model cache and connection pooling

**Status:** Agreed design, staged rollout. Written 2026-11-25; decisions recorded
the same day (§9).
**Author:** Lloyd, with Claude.
**Supersedes, once shipped:** the pooling notes in `src/lib/malloy.ts` and the
`MODEL_DEF_CACHE` path (`src/lib/model-cache.ts`, PR #58).
**Related:** `docs/architecture.md`, `docs/explore-surface.md`,
`docs/multi-tenant-givens.md` (identity rides on the Runtime),
`src/lib/duckdb-sandbox.ts` (the per-repo DuckDB boundary, #211).

---

## 1. Summary

A query needs three things: the **catalog**, the **compiled model** and a
**connection**. Today one 16-slot pool of runtimes per model version holds the
last two, and the catalog is rebuilt by compiling every visible model on every
call. This design gives each its own store, lifetime and budget.

| Thing | Depends on | Stored | Evicted by |
|---|---|---|---|
| Catalog | model version | Postgres, written at publish | never (immutable per version) |
| Compiled model | model version + entry URL | memory → Postgres | bytes (memory); never (Postgres, cascades with versions) |
| Connection | connection name + resolved settings | process-wide registry | idle time and a connection budget, never while leased |

```
MCP tool call ──┬─▶ 1 · Catalog          malloy_models.catalog, written at publish
(list/describe/ │                        list_sources stops here: two Postgres reads
 query)         ├─▶ 2 · Compiled model   memory ─▶ Postgres ─▶ compile once
                │                        Postgres keeps models warm across restarts
                └─▶ 3 · Connection slots per connection key, leased per request;
                                         busy slots queue work fairly
```

Every wait has a deadline, every cache is bounded in bytes, every limit is a
setting, and nothing per-node is needed for correctness.

## 2. Goals

The bar: push the limits way out. The design targets 100+ datasets and 100+
concurrent queries per node, with nothing that caps at thousands.

1. **Listing is flat in N.** `list_sources` costs the same with 3 or 3,000
   visible datasets: one or two indexed Postgres reads, no compile, no
   connection.
2. **No cliffs.** No count-based limit (16 pools, 16 defs, 16 views, 4 zips)
   decides performance. Caches are sized in bytes and degrade gradually.
3. **No hangs.** Every request gets a connection, or a clear error naming the
   dataset within a bounded wait, after waiting its turn in a fair queue.
4. **Cluster-ready, not clustered.** No load balancer in this work, but nothing
   per-node is needed for correctness, so adding nodes later needs no redesign.
   A restarted node is warm after one Postgres read per model version.
5. **Bounded load on the customer's warehouse.** A server opens at most `slots`
   per connection, and slots are the customer's to set.
6. **No Malloy internals.** The persistent cache uses Malloy's public
   `CacheManager` / `ModelCache` API; `_modelDef` and `_loadModelFromModelDef`
   retire.

**Not in v1:** sharing DuckDB state across repos; load balancing and anything
cross-node; a local-disk or object-store cache layer (the interface leaves
room).

## 3. What happens today

Every `list_sources`, `describe_source` and `query` call leases and compiles
every dataset the user can see, one after another, before doing its own work.
`query` with `model_ref` still does it, for the source-not-in-model guard
(`packages/mcp-engine/src/surfaces/explore.ts` ~230, ~360, ~523). Read at
`main` (`eaf91ff`, v0.2.83) against Malloy 0.0.431; **measured** items were
reproduced in this session (§10).

| # | Finding | Where | Effect | Status |
|---|---|---|---|---|
| 1 | `list()` compiles every visible model sequentially on every call, plus ~3 DB round trips per dataset. | `src/lib/mcp-host.ts` `list` | Cost grows with N on every tool call. | read |
| 2 | Three tools call `list()`; `model_ref` doesn't avoid it. | `explore.ts` | No way to opt out. | read |
| 3 | Pools capped by count (`MAX_POOLS = 16`, 5 entries each). Eviction closes connections and drops the `CacheManager`, even for a busy pool. | `src/lib/malloy.ts` `poolFor` | Past 16 active versions every `list()` evicts what it needs next: the ~90 s cliff. | read |
| 4a | A waiter on a saturated pool is never served once the pool is drained. | `RuntimePool.release` | Hang until platform timeout. | **measured** |
| 4b | A waiter queued behind a build that fails is never served: the slot is returned but no build starts for the queue. | `RuntimePool.acquire` | Same hang, from any transient connect error under load. | **measured** |
| 4c | `acquire()` has no timeout; a lease that never returns blocks the dataset forever. | `RuntimePool.acquire` | One stuck warehouse query wedges a dataset. | **measured** |
| 5 | Other caches are count-bounded (defs 16, views 16, zips 4); `dashboards/bundle.ts` is unbounded and grows on every draft edit. | `malloy.ts`, `repo-files.ts`, `bundle.ts` | Thrash past 4 repos; slow leak. | read |
| 6 | `latestModel` selects every column, incl. the multi-MB `compiled_model_def`. | `src/lib/mcp-tools.ts` | N blobs per `list()` where the cache was ever on. | read |
| 7 | `CacheManager.getCachedModelDef` misses when its in-memory maps are empty, before asking the `ModelCache`. | malloy `foundation/cache.ts` | A persistent cache is never read after restart. | **measured** |
| 8 | Nothing dedupes concurrent compiles of one version. | `CacheManager`, `withModelRuntime` | 5 cold requests = 5 compiles. | read |
| 9 | DuckDB gets its defaults per instance: `memory_limit` 80% of RAM, `threads` all cores; up to 80 instances per process. | `sandboxDuckDBConnections` | OOM risk under concurrent heavy queries. | **measured** |
| 10 | `idle()` is a no-op for in-memory DuckDB; for `md:`/file it drops the instance and replays setupSQL on wake. | `@malloydata/db-duckdb` | Idling saves sockets, not memory, for the common case. | read |
| 11 | Registered `postgres` is the non-pooled driver: new `pg.Client` per query. MySQL serializes one socket per object; Snowflake pools internally; BigQuery and Trino are HTTP. | `@malloydata/db-*` | Pooling never reused a Postgres socket; it kept the schema cache. | read |
| 12 | App Postgres pool is 10 per process. | `src/db/index.ts` | A bottleneck at 100 concurrent requests. | read |
| 13 | MCP is stateless per request; boot migrations are advisory-locked. | `src/app/mcp/route.ts`, `src/lib/migrate.ts` | Already cluster-safe. | read |
| 14 | `wrapConnections()` lets a host hand out its own connections; `shutdown('close')` closes only what the config made. | malloy `foundation/config.ts` | Shared connections survive per-request shutdown. | **measured** |

Findings 4a–4c are the likely cause of "stuck at 32 concurrent": finding 1
multiplies every call by N, finding 3 turns N > 16 into eviction churn, and
eviction strands a busy pool's waiters.

## 4. Design

### 4.1 The catalog comes from publish-time data

A catalog entry is a pure function of the model version, the same for every
user and call, so `list()` should never compile.

- **Store** `malloy_models.catalog jsonb`: the engine's own `modelCatalogEntry`
  over an `exportedOnly` compile, **without** `model_ref`. That is the
  dataset's ref, filled in at read time, so a rename never rewrites history.
  One journal entry (`npx drizzle-kit generate --name malloy_models_catalog`).
- **Write** it at publish in `src/lib/repo-publish.ts`, next to `sources`. If
  the publish workspace compile ever diverges from the served shape, compute it
  through the serving path instead.
- **Read**: `list()` becomes two queries regardless of N. First, visible
  datasets joined to their active model's `id, catalog` (no blobs, no
  `source`). Second, all dashboards for those model ids with
  `WHERE model_id = ANY(...)`.
- **Backfill**: a version with `catalog IS NULL` is computed once through the
  normal lease path (which also warms the model cache), then written with
  `UPDATE … WHERE catalog IS NULL`. Concurrent computes are harmless; the write
  is idempotent.
- **Failure**: a model that won't compile lists as a bare `{ model_ref }`, as
  today, and is not written back, so a transient warehouse error doesn't freeze
  a bare entry.
- `resolveModel` and the query guard keep calling `list()`; it is cheap now.
  The host may memoize it for one request.

### 4.2 Compiled models through Malloy's own cache API

One small upstream fix makes a persistent `ModelCache` work; malloyyo then
keeps compiled models in memory, backed by a Postgres table.

**Upstream (malloydata/malloy).** In `CacheManager.getCachedModelDef`, when the
in-memory maps have no entry, fall through to `modelCache.getModel(url)`. Check
each stored invalidation key against the reader, fill the maps, return the hit.
`CachedModel` already carries the keys, so there is no format change. Keys are
content hashes (uuid v5 of the file text), stable across processes. A subclass
prototype of exactly this passed all three checks in §10.

The change, in `packages/malloy/src/api/foundation/cache.ts` (today the method
starts with `if (_dependencies === undefined) return undefined;`):

```ts
async getCachedModelDef(urlReader: URLReader, url: string) {
  if (!this.modelDependencies.has(url)) {
    // This process has never seen the model. The ModelCache may outlive the
    // process (disk, a database), so ask it before giving up.
    const cached = await this.modelCache.getModel(new URL(url));
    if (cached === undefined) return undefined;
    const deps = [url, ...flatDeps(cached.modelDef.dependencies)];
    const keys: Record<string, string> = {};
    for (const dep of deps) {
      const stored = cached.invalidationKeys[dep];
      if (stored === undefined || stored === null) return undefined;
      // Same check the warm path does: the file must still hash the same.
      if ((await getInvalidationKey(urlReader, new URL(dep))) !== stored) return undefined;
      keys[dep] = stored;
    }
    // Valid: remember it, so the next lookup takes the in-memory path.
    this.modelDependencies.set(url, cached.modelDef.dependencies);
    for (const dep of deps) this.modelInvalidationKeys.set(dep, keys[dep]);
    return { modelDef: cached.modelDef, invalidationKeys: keys };
  }
  // … the existing in-memory path, unchanged
}
```

Plus a doc comment on `ModelCache`: its keys are URLs, and the invalidation
check covers only Malloy source files. A cache that outlives a process or is
shared between configs must namespace by anything else that shapes compilation
(connection config, the warehouse). And a unit test: populated `ModelCache` +
fresh `CacheManager` → hit with no schema fetch; edited file → miss; `null` key
(internal URL) → miss.

**malloyyo, after `/malloy-update`:** a `LayeredModelCache` per model version.

| Layer | Where | Bound | Lifetime | Notes |
|---|---|---|---|---|
| L1 | process memory | `MALLOYYO_MODEL_CACHE_MEMORY_MB` | the process | LRU by serialized bytes |
| L2 | Postgres `compiled_models` | none (rows cascade with versions) | survives restarts and deploys; shared if nodes are added | read on an L1 miss, written after a compile |

No local-disk layer: `/tmp` does not survive a restart on malloyyo.com hosts,
so Postgres is what keeps a restart warm. The `ModelCache` interface leaves
room for a disk layer where disk does persist.

- **Namespaced per version.** Every dataset's entry is `file:///index.malloy`,
  and the content-hash check covers only Malloy source files, not
  `malloy-config.json` or the warehouse. Two datasets with identical
  `index.malloy` text but different connections would otherwise share a
  compiled model. The model version id covers both.
- **The Postgres layer is required, not optional.** It is the only thing that
  survives a restart or deploy. Without it every restart recompiles every model
  on first touch, hitting the customer's warehouse again.
- **A table, not a column.** Dashboards compile other entries
  (`dashboards/<name>.malloy`), so one version has several URLs. PK
  `(model_id, url_hash)`, insert `ON CONFLICT DO NOTHING`. Drop
  `malloy_models.compiled_model_def` one release after reads stop (the 0014
  lesson in CLAUDE.md).
- **Single-flight per process.** One in-flight promise per model id + URL, so
  32 cold requests compile once.
- **Publish warms it** through the serving path (same reader, same sandboxed
  config). Best-effort: a warm failure never fails the publish.
- **Drafts** use L1 only.
- **Retire** the `_modelDef` path in `src/lib/model-cache.ts`,
  `model-cache.pin.test.ts`, `MODEL_DEF_CACHE` and `L1_MAX`.
- **Warehouse schema drift.** A cached model keeps the table schemas it was
  compiled against. Today thrash and restarts hide this; a durable cache makes
  it last until republish. Open question (§9).

Identity never enters a compiled model: givens ride on the per-request Runtime,
so one cached def serves every user.

### 4.3 A process-wide connection registry, leased per request

The pool stops being "N whole runtimes per model version" and splits into two
objects with different lifetimes.

- **`ModelHandle` per model version** (replaces `RuntimePool`): file map,
  config JSON, the layered `CacheManager`, the finalized-givens set. Holds no
  sockets; LRU'd by bytes. Dropping it never closes a connection.
- **`ConnectionRegistry` per process**: connection key → a small pool of live
  `Connection` objects (**slots**).

**Per request:** build a fresh `MalloyConfig` from the handle (it opens nothing
until a lookup) and `wrapConnections()` it. The first lookup of each name
leases a slot; the end of the request returns every lease.
`config.shutdown('close')` then closes nothing shared. The Runtime is built per
request, carrying the asker's givens.

**Connection key** = connection name + sha256 of the resolved settings, after
`{"env": …}` references are filled in and before sandbox options are added. The
name is in the key because compiled models and the schema cache refer to
connections by name. If resolving the entry needs Malloy internals
(`resolveCompiledEntry`), add a small public API upstream.

**Scope of sharing:**

- **Remote warehouses** (BigQuery, Postgres, MySQL, Snowflake, Trino): shared by
  every dataset on the server. Identity is on the Runtime, not the connection.
- **DuckDB**: shared only for byte-identical entries within one repo, because
  setupSQL builds state (ATTACH, views, secrets) and temp tables would be
  visible across datasets. The key adds the repo id, and the scratch dir derives
  from the key instead of a fresh `mkdtemp`. DuckDB's own share key then puts
  same-key slots on one `DuckDBInstance`: one buffer pool, one `memory_limit`.
- **The no-config fallback** (in-memory DuckDB or `md:`) shares within a repo
  in v1.

**Slots per key.** DuckDB and MySQL serialize per object, Postgres opens a
client per query, Snowflake pools internally, BigQuery and Trino are concurrent
HTTP. The rule correct for all of them: up to `slots` per key, one in-flight
query per slot. `slots` is set per connection in `malloy-config.json`
(replacing the provisional top-level `poolSize`); the default is
`MALLOYYO_CONNECTION_SLOTS` = 8.

```
            slot frees, FIFO          returned            60 s unused        900 s idle, or
  Queued ─────────────────▶ Leased ─────────▶ Warm ────────────▶ Idle ─────────────────▶ Closed
    │                        ▲  ◀──── leased ───┘                  │      over budget (LRU)
    │ 120 s deadline         └──────── leased again: reattach, schemas kept ┘
    ▼
  Fails fast — error names the dataset, the connection and the reason
```

A returned slot is warm; after `MALLOYYO_CONNECTION_IDLE_SECONDS` it goes idle
(`connection.idle()`: sockets and file locks released, client and schemas
kept), and after `MALLOYYO_CONNECTION_CLOSE_SECONDS`, or when the process is
over `MALLOYYO_MAX_CONNECTIONS`, the least-recently-used unleased slot closes.

**The query queue** (fixes 4a–4c). Dashboards fire many queries at once, so a
busy connection queues work rather than rejecting it. All of this lives in one
module (`src/lib/query-queue.ts`) with no I/O, so it is unit-testable on its
own.

- **One queue per connection key.** A query that finds every slot busy waits in
  line; nothing is rejected for being in line.
- **Fair between requests.** Waiters are grouped by request (one dashboard
  view, one agent call). A freed slot goes to the next request in rotation,
  first-in-first-out within a request. A dashboard alone gets every free slot;
  with company, its 30 tiles can't starve another user's single query. That is
  a list of per-request queues and a round-robin pointer, nothing more.
- **Deadline** `MALLOYYO_QUEUE_WAIT_SECONDS` = 120. A returned slot goes
  straight to the next waiter; a failed slot build frees its slot and builds
  for the next waiter.
- **Safety cap** `MALLOYYO_MAX_QUEUED` (10,000 per process) protects memory
  only; it is not a load-shedding knob.
- Leases return in a `finally`, so a thrown or timed-out query never leaks a
  slot.

**Every failure says which kind it is.** Three different things go wrong, and
the message names the dataset, the connection and the reason:

| Kind | Example message |
|---|---|
| Waited, never ran | Query on dataset 'sales/orders' waited 120s for connection 'warehouse' and did not run: all 8 slots were busy, with 37 queries ahead of it. Try again, or raise `slots` for 'warehouse' in malloy-config.json. |
| Could not connect | Query on dataset 'sales/orders' could not open connection 'warehouse': \<driver error\>. The query did not run. |
| Ran and the database failed | Query on dataset 'sales/orders' ran on 'warehouse' for 94s and the database returned: \<error, e.g. statement timeout\>. |

**DuckDB resources.** Each sandboxed DuckDB entry gets `memoryLimit` and
`threads` from a process budget unless the repo sets them.
`MALLOYYO_DUCKDB_MEMORY_MB` (default 50% of memory) is split across live
instances, not slots, with a floor. `MALLOYYO_DUCKDB_THREADS` defaults to
cores ÷ 2, at least 1. This is what makes high DuckDB concurrency slow down
instead of running out of memory.

### 4.4 More nodes later, small fixes, observability

What a node holds is a cache; what nodes must agree on lives in Postgres.

| State | Where | With more nodes |
|---|---|---|
| Catalog | Postgres | identical on every node |
| Compiled models | memory per node, Postgres shared | a cold or restarted node reads Postgres, never recompiles a published version |
| Connections | per node | warehouse load is `nodes × slots` per key |
| App DB pool | per node (`MALLOYYO_DB_POOL_SIZE`) | `nodes × pool`: put a pooler in front for large clusters |
| Migrations | Postgres advisory lock | already serialized |
| MCP sessions | none (stateless) | no stickiness needed |

Health checks keep polling `/api/healthz` (no I/O), never the deep route.

**Small fixes (independent):**

- `latestModel` selects only the columns callers use, never
  `compiled_model_def` or `source` unless asked.
- `repo-files.ts` `views` and `indexes`, and the `dashboards/bundle.ts` cache:
  LRUs bounded by bytes under one `MALLOYYO_REPO_CACHE_MB`.
- Optionally, upstream registers `PooledPostgresConnection` (or a `pool: true`
  option), so a Postgres slot reuses sockets instead of a handshake per query.

**Observability.** One structured log line per request: catalog source
(`stored` / `computed`), model cache result (`memory` / `postgres` /
`compiled`) and compile ms, queue wait ms and position at enqueue, slots opened
/ idled / closed, and on failure which of the three kinds it was. Every 60 s
per node: open slots by key, queued queries by key, in-memory model cache
bytes.

## 5. Theory of operation

*The product doc. It moves into `docs/` proper (and `docs/architecture.md`
links it) when the code matches it.*

A Malloyyo server answers a query from three things it keeps warm: **the
catalog, the compiled model, and a connection.** Each has its own cache and
lifetime, so losing one never costs the other two. None is needed for
correctness on any particular server.

**The catalog** is what `list_sources` shows: each dataset's description and
exported sources. It is computed once, when a model version is published, and
stored with that version. Listing reads it from the database and never compiles
a model or opens a connection. Listing costs the same with 3 datasets or 3,000,
and a model that fails to compile still lists.

**Compiled models.** Compiling parses the model's files and fetches the schema
of every table it reads, which on a remote warehouse can take seconds per
source. A model version never changes, so a compiled model is never invalidated
by edits, only evicted when memory runs short. It is kept in memory and in the
database, so a restart or deploy never recompiles a published version. On every
hit, Malloy checks each file against a content hash; a stale or corrupt entry
is recompiled. Publishing warms both layers, and many requests for a cold model
wait for a single compile.

**Connections.** A connection is a live client for one database. Requests share
connections that would be identical: same name, same settings after `env`
values are filled in. Remote warehouses are shared across every dataset on the
server; DuckDB only within one repo, because its setup SQL builds state on the
connection. Each connection has a number of slots, one running query per slot,
set per connection in `malloy-config.json`. That caps what a server can open
against your warehouse.

A request leases the slots it uses and returns them when it finishes. An unused
slot is **warm**, then after a short idle time **idle** (sockets and file locks
released, client and schemas kept), then after a longer idle time, or when the
server is over its connection budget, **closed**, least recently used first. A
slot in use is never closed.

**Queries wait in line, fairly.** When every slot for a connection is busy, a
query queues. The queue takes turns between requests, so one dashboard's many
tiles can't starve another user's single query. A query that waits 120 seconds
without a slot fails without having run, and the error says so: which dataset,
which connection, how many queries were ahead of it, and how to add slots. That
error is distinct from a connection that can't open and from a query the
database itself failed or timed out. DuckDB gets a share of the server's memory
and cores rather than most of the machine per instance, so many concurrent
DuckDB queries slow down instead of exhausting memory.

**What a query does:**

1. Resolve the dataset and its active model version from the catalog.
2. Get the compiled model: memory, then the database, else compile once and
   write both.
3. Lease a slot for each connection the query uses, waiting in the fair queue
   if all are busy.
4. Build a per-request runtime carrying the asker's identity (givens), and run.
5. Return the slots.

**Identity and isolation.** The asker's identity rides on the per-request
runtime, never on a connection or a cached model. Sharing a connection shares a
database client, not who is asking. Each repo's DuckDB connections keep their
own sandbox directory.

**When it is slow,** the logs name the layer. A high compile count means the
model cache is smaller than the working set. Many connections opened means the
budget or idle times are too tight. Long queue waits mean a connection has too
few slots for its concurrency.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `slots` on a connection in `malloy-config.json` | `MALLOYYO_CONNECTION_SLOTS` (8) | concurrent queries on that connection, per server |
| `MALLOYYO_MAX_CONNECTIONS` | 256 | open slots per server, all connections |
| `MALLOYYO_QUEUE_WAIT_SECONDS` | 120 | longest a query waits for a slot before failing without running |
| `MALLOYYO_MAX_QUEUED` | 10,000 | queued queries per server; memory safety only |
| `MALLOYYO_CONNECTION_IDLE_SECONDS` | 60 | warm → idle |
| `MALLOYYO_CONNECTION_CLOSE_SECONDS` | 900 | idle → closed |
| `MALLOYYO_MODEL_CACHE_MEMORY_MB` | 512 | in-memory compiled models |
| `MALLOYYO_DUCKDB_MEMORY_MB` | 50% of memory | split across DuckDB instances |
| `MALLOYYO_DUCKDB_THREADS` | cores ÷ 2 | per DuckDB instance |
| `MALLOYYO_REPO_CACHE_MB` | 256 | repo zips, views, dashboard bundles |
| `MALLOYYO_DB_POOL_SIZE` | 30 | app Postgres connections per server (today 10, fixed) |

## 6. Staging

Six stages, each its own PR, green on `bash scripts/preflight.sh`, and measured
by the stage 0 load test before and after. Stages 1 and 2 alone should make 100
datasets usable; stage 3 makes 100 concurrent queries safe. The Malloy PR opens
alongside stage 1, so its release is not on the critical path.

| Stage | What ships | What you'll see | Tests | Size |
|---|---|---|---|---|
| 0. Measure | `scripts/load-test.ts`: N datasets, `list_sources`, and 100 concurrent dashboard-style queries; p50/p99 and hang count | today's numbers, the baseline for every stage | — | small |
| 1. Stop the bleeding | fix the three pool hangs; 120 s wait deadline with a clear reason; never evict a pool with leases or waiters; `latestModel` selects only what callers use | no stuck calls; the cliff past 16 softens | the three §10 repros flip from HUNG to settled; timeout message; no slot leak on build failure | small |
| 2. Catalog from publish | `malloy_models.catalog`, written at publish; two-query `list()`; first-list backfill | `list_sources` flat in N; describe and query stop compiling every model | stub-host `list()` with zero compiles; `test:hosted` publish → list; backfill once | medium, one migration |
| 3. Query queue + connection registry | per-process registry, per-request leases, `slots` in `malloy-config.json`, fair queue, idle → close, connection budget, DuckDB memory and thread split, app DB pool setting | 100 concurrent dashboard queries queue and complete; busy datasets are never torn down | queue units (fairness, deadline, FIFO in a request, no leaks); registry units with fake connections; DuckDB sharing stays in-repo | large |
| 4. Restart-proof model cache | Malloy release → `/malloy-update` → memory + Postgres `ModelCache` via Malloy's API, single-flight, publish warm; retire `MODEL_DEF_CACHE` and the internal APIs | a restart or deploy doesn't recompile every model | restart → 0 schema fetches; 32 concurrent cold → 1 compile; cross-version isolation | medium, gated on Malloy |
| 5. Clean up | byte-bounded repo and bundle caches; drop `compiled_model_def` one release later; theory of operation into `docs/` | memory stays bounded on long-running servers | LRU-by-bytes units; migrate tests | small |

**The load test** runs ~100 datasets across ~5 repos, one node. It measures
`list_sources` and `query` p50/p99, and 100 concurrent `query` calls shaped like
dashboards (bursts of 20–30 from one request, single queries from others). Pass
= flat listing, zero hangs, every failure carrying its reason, no recompile
after a restart (once stage 4 lands).

## 7. Alternatives considered

| Alternative | Why not |
|---|---|
| Raise `MAX_POOLS` | Moves the cliff to the next N; connections still die with compiled models and are multiplied by versions. |
| Cache `list()` in memory per node | N compiles on every cold process and eviction, plus invalidation on publish. The catalog is immutable per version; storing it is simpler and exact. |
| Keep #58's Postgres column with internal APIs | Couples malloyyo to Malloy internals, one entry per version (dashboards miss), fixes nothing for other Malloy hosts. |
| One `Connection` per key for every driver | Right for HTTP drivers, but caps DuckDB and MySQL at one query at a time. Slots are correct for all. |
| Shed load when the queue is long | Dashboards legitimately fire bursts; a fair queue with a deadline serves them, and the deadline still bounds every wait. |

## 8. Risks

| Risk | Mitigation |
|---|---|
| Shared remote connection carries dataset-specific session state | setupSQL is part of the resolved settings, so different setupSQL means a different key. |
| Postgres cache layer unavailable or slow | Cache reads and writes are best-effort: a failure degrades to memory plus a compile, never an error. |
| Postgres size: several MB per version × entry | Rows cascade with versions; retention for inactive versions can follow. |
| Dropping `compiled_model_def` while the live build reads it | Stop reading in one release, drop in a later one (the 0014 lesson). |

## 9. Decisions

Lloyd settled these on 2026-11-25; the design above reflects them.

| Question | Decision |
|---|---|
| Scale target | High. Design for 100+ datasets and 100+ concurrent queries per node now; nothing caps at thousands. |
| Andrew's PR | Ignore; not part of this plan. |
| Slots | `slots` on each connection in `malloy-config.json`, replacing the provisional top-level `poolSize`. |
| Overload | A fair query queue (turns between requests, FIFO within one), not load shedding. Kept simple and local to one module. |
| Queue deadline | 120 s, and every failure says which kind it is: waited and never ran, could not connect, or ran and the database failed. |
| Load balancing | Not now. Nothing per-node is needed for correctness, so it can come later without redesign. |
| Local disk cache | Dropped: `/tmp` doesn't survive a restart. Memory + Postgres. |
| DuckDB across repos | Not shared in v1. |
| Malloy upstream | Only the `CacheManager` fall-through is required. A pooled Postgres registration is optional and separate. |

Still open:

- **Warehouse schema drift.** A durable cache keeps a model's table schemas
  until republish, so a column added in the warehouse stays invisible. Options:
  accept it (republish or a refresh picks it up), or give Postgres entries a
  max age (e.g. 24 h) after which the next query recompiles.

## 10. Evidence: how to reproduce

All three pool hangs and the restart cache miss reproduce against
`@malloydata/malloy@0.0.431` and `@malloydata/db-duckdb@0.0.431` (the
lockfile's versions), run outside the repo.

**Pool hangs (4a–4c).** `RuntimePool` copied verbatim from `src/lib/malloy.ts`;
each promise raced against a 500 ms timer. 3 of 3 came back `HUNG`.

```ts
// A: drained while saturated (max 2)
const a = await pool.acquire(), b = await pool.acquire();
const third = pool.acquire();
await pool.drain(); pool.release(a); pool.release(b);
// third: HUNG

// B: queued behind a failing build (max 1; first build throws)
const first = pool.acquire(), second = pool.acquire();
// first: rejected; second: HUNG

// C: a lease that never returns (max 1)
await pool.acquire();
// pool.acquire(): HUNG — no deadline
```

**Persistent cache (7).** A DuckDB model with an inline SQL source and a CSV
table; `wrapConnections` counts `fetchSchemaFor*` calls; a `Map`-backed
`ModelCache` outlives each `CacheManager`, simulating a restart.

| Run | Schema fetches |
|---|---|
| Cold compile, stock `CacheManager` | 2 |
| New stock `CacheManager`, same populated store | **2** (store ignored) |
| New fall-through `CacheManager`, same store | **0** (rows correct) |
| File edited, fall-through | 2 (correctly recompiled) |

**`shutdown('idle')` (10).** Query, `shutdown('idle')`, query again on the same
config: `idle()` called once, `close()` 0 times, second query correct.

**Shared connection (14).** One connection handed to two configs via
`wrapConnections`, each `shutdown('close')`: the shared connection's `close()`
was called 0 times.

**DuckDB defaults (9).** `current_setting('memory_limit')` = 10.6 GiB and
`threads` = 4 on a 4-core, 17 GB container. 40 idle in-memory instances added
about 0 MB RSS.
