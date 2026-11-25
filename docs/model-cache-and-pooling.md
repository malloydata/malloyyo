# Design: catalog, compiled-model cache and connection pooling

**Status:** Proposed, for agreement before any code lands. Written 2026-11-25.
**Author:** Lloyd, with Claude.
**Supersedes, once shipped:** the pooling notes in `src/lib/malloy.ts` and the
`MODEL_DEF_CACHE` path (`src/lib/model-cache.ts`, PR #58).
**Related:** `docs/architecture.md`, `docs/explore-surface.md`,
`docs/multi-tenant-givens.md` (identity rides on the Runtime),
`src/lib/duckdb-sandbox.ts` (the per-repo DuckDB boundary, #211).

---

## 1. Summary

A query on a Malloyyo server needs three things: the **catalog** (what exists),
the **compiled model**, and a **connection**. Today one object, a per-model-version
`RuntimePool`, holds the last two, and the catalog is computed by compiling
every model on every call. They live and die together in a 16-slot LRU.

The design separates them. Each gets its own store, its own lifetime and its
own budget:

| Thing | Depends on | Stored | Evicted by |
|---|---|---|---|
| Catalog | model version | Postgres, written at publish | never (immutable per version) |
| Compiled model | model version + entry URL | memory → local disk → shared store (Postgres) | bytes, per layer |
| Connection | connection name + resolved settings | process-wide registry | idle time and a connection budget, never while leased |

Every wait has a deadline, every cache is bounded in bytes, every limit is a
setting rather than a constant, and no correctness property depends on which
node of a cluster answers.

## 2. Goals

Lloyd's bar: **push the limits way out, and if we spin up a cluster for a
customer, it works.** Concretely (targets to agree on, see §9):

1. **Listing is flat in N.** `list_sources` costs the same with 3 or 3,000
   visible datasets: one or two indexed Postgres reads, no compile, no
   connection.
2. **No cliffs.** No count-based limit (16 pools, 16 defs, 16 views, 4 zips)
   decides performance. Caches are sized in bytes; working sets larger than the
   cache degrade gradually.
3. **No hangs.** Every request either gets a connection, gets a clear error
   naming the dataset within a bounded wait, or is shed quickly when the node
   is overloaded. Nothing waits for the platform timeout.
4. **Cluster-correct.** N stateless nodes behind a load balancer with no
   stickiness. Per-node state is only ever a cache. A new node, or a node that
   restarts, is warm after one shared-store read per model version, not a
   recompile.
5. **Bounded blast radius on the customer's warehouse.** Total connections a
   cluster opens to one warehouse are `nodes × per-key cap`, and the per-key cap
   is the customer's to set.
6. **No Malloy internals.** The persistent cache goes through Malloy's public
   `CacheManager`/`ModelCache` API; `_modelDef` / `_loadModelFromModelDef`
   retire.

Non-goals for v1: sharing DuckDB state across repos; cross-node single-flight
of compiles (publish pre-warming makes it rare); an object-store layer (the
`ModelCache` interface leaves room for one).

## 3. What happens today

Everything below was read at `main` (`eaf91ff`, v0.2.83) against Malloy
0.0.431, and the items marked **measured** were reproduced in this session
(§10 has the scripts).

### 3.1 How one call flows

```
list_sources / describe_source / query
  └─ host.list()                                   src/lib/mcp-host.ts
       for each visible dataset (sequentially):
         latestModel()          SELECT * — incl. multi-MB compiled_model_def
         modelFileMap()         repo zip from Postgres (LRU of 4 zips, 16 views)
         leaseDataset()         poolFor(model.id) → acquire → compile exportedOnly
         listDashboardsForModel()
  └─ then the actual describe/query: lease + compile again (cache hit if the pool survived)
```

`describe_source` and `query` without `model_ref` call `list()` through
`resolveModel`; `query` **with** `model_ref` still calls it for the
source-not-in-model guard (`packages/mcp-engine/src/surfaces/explore.ts`
~230, ~360, ~523). So every call touches every visible dataset.

### 3.2 Findings

| # | Finding | Where | Effect | Status |
|---|---|---|---|---|
| 1 | `list()` compiles every visible model, one after another, on every call, plus ~3 DB round trips per dataset. | `mcp-host.ts` `list` | Cost grows with N on every tool call. Andrew's "every query reads every model". | read |
| 2 | Three tools call `list()`; passing `model_ref` does not avoid it. | `explore.ts` | No way for a caller to opt out. | read |
| 3 | Pools are capped by **count** (`MAX_POOLS = 16`, 5 entries each). Eviction closes the connections **and** drops the `CacheManager`, even for a busy pool. | `malloy.ts` `poolFor` | With > 16 active versions, each `list()` evicts pools it needs on the next call. The ~90 s cliff. | read |
| 4a | A waiter queued on a saturated pool is never served once that pool is drained: `release()` on a draining pool cleans up and returns without looking at `waiters`. | `RuntimePool.release` | Hangs until the platform kills the request. | **measured** |
| 4b | A waiter queued behind a build that **fails** is never served: the slot is returned (`size--`) but nobody starts a build for the queue. | `RuntimePool.acquire` | Same hang; triggered by any transient connect/config error under load. | **measured** |
| 4c | `acquire()` has no timeout. A lease that never returns (a stuck warehouse query) blocks every later caller for that version forever. | `RuntimePool.acquire` | Same hang; one slow query can wedge a dataset. | **measured** |
| 5 | Every other cache in the path is count-bounded: compiled defs `L1_MAX = 16`, repo views 16, revision indexes 4 (each a whole repo zip). `dashboards/bundle.ts`'s cache is **unbounded** (keyed by source hash, so every draft edit adds an entry forever). | `malloy.ts`, `repo-files.ts`, `bundle.ts` | Thrash past 4 repos / 16 datasets; slow leak on long-lived nodes. | read |
| 6 | `latestModel` selects every column, including `compiled_model_def`. | `mcp-tools.ts` | With `MODEL_DEF_CACHE` ever on, every `list()` pulls N blobs. | read |
| 7 | Malloy's `CacheManager.getCachedModelDef` returns a miss when its in-memory dependency map is empty, **before** asking the `ModelCache`. A persistent `ModelCache` is never read after a restart. | `malloy/.../foundation/cache.ts` | Why #58 went around Malloy with internal APIs and a Postgres column. | **measured**: stock manager over a populated store → 2 schema fetches; with a fall-through → 0, correct rows; edited file → recompiles |
| 8 | Nothing dedupes concurrent compiles of the same version. A cold version hit by 5 concurrent requests compiles 5 times (one per pool entry; they share a `CacheManager`, but each misses before any writes). | `CacheManager`, `withModelRuntime` | Cold-start storms multiply schema fetches against the warehouse. | read |
| 9 | Every pooled DuckDB instance gets DuckDB's defaults: `memory_limit` = 80% of RAM and `threads` = all cores. 16 pools × 5 entries = up to 80 instances, each believing it owns the machine. | `sandboxDuckDBConnections` sets neither | Fine idle (**measured**: 40 idle instances ≈ 0 MB RSS); under concurrent heavy queries, oversubscription and OOM risk. | **measured** (10.6 GiB / 4 threads on a 4-core box) |
| 10 | `shutdown('idle')` is a no-op for in-memory DuckDB (it would lose state). For `md:`/file DuckDB it drops the instance and replays setupSQL on wake. For remote warehouses it releases sockets. | `@malloydata/db-duckdb` `idle()` | "Idle before close" saves sockets, not memory, for the common DuckDB case. | read |
| 11 | The registered `postgres` type is the **non-pooled** `PostgresConnection`: a new `pg.Client` per query (connect → setup → query → end). MySQL holds one serialized socket per object. Snowflake pools internally. BigQuery and Trino are HTTP clients. | `@malloydata/db-*` | For Postgres, pooling never reused a socket; it kept the schema cache. Each query pays a TCP+TLS+auth handshake. | read |
| 12 | The app's own Postgres pool is 10 per process. | `src/db/index.ts` | With finding 1, 32 concurrent calls queue here. In a cluster, `nodes × 10` against the app DB. | read |
| 13 | MCP is stateless per request; no sticky sessions needed. Boot migrations are advisory-locked. | `app/mcp/route.ts`, `migrate.ts` | Already cluster-safe. | read |
| 14 | `MalloyConfig.wrapConnections()` lets a host hand out connections it owns; `config.shutdown('close')` closes only what the managed lookup created. | `malloy/.../foundation/config.ts` | Shared connections survive a per-request config's shutdown. | **measured**: shared connection, 2 configs each `shutdown('close')` → 0 `close()` calls |

Findings 4a–4c are the likely explanation for "stuck at 32 concurrent". Finding
1 multiplies every call by N, finding 3 turns N > 16 into eviction churn,
eviction drains busy pools, and a drained busy pool strands its waiters.

## 4. Design

### 4.1 The catalog comes from publish-time data

A catalog entry (the model's `##"` description; each exported source's name,
`#"` description and `must_quote`) is a pure function of the model version. It
is the same for every user and every call.

- **Store** `malloy_models.catalog jsonb`: the output of the engine's own
  `modelCatalogEntry` over an `exportedOnly` compile, **without** `model_ref`
  (that is the dataset's ref, filled in at read time, so a dataset rename never
  rewrites history). One journal entry: `npx drizzle-kit generate --name
  malloy_models_catalog`.
- **Write** it at publish (`repo-publish.ts`, next to `sources`). The publish
  compile runs in an on-disk workspace, so it reuses that compile's model; if
  that ever diverges from the served shape, publish computes it through the
  serving path instead (§4.2 warms that path anyway).
- **Read**: `list()` becomes two queries regardless of N:
  1. visible datasets ⋈ their active model's `id, catalog` (no blobs, no
     `source`);
  2. all dashboards for those model ids in one `WHERE model_id = ANY(...)`.
- **Backfill**: a version with `catalog IS NULL` is computed once (through the
  normal lease path, so it also warms the model cache), written back with
  `UPDATE … WHERE catalog IS NULL`, and never again. Concurrent nodes may both
  compute it; the write is idempotent.
- **Failure**: a model whose catalog can't be computed lists as a bare
  `{ model_ref }` exactly as today, and is retried on the next list (not
  written back), so a transient warehouse error doesn't freeze a bare entry.
- `resolveModel` and the source-not-in-model guard keep calling `list()`; it is
  cheap now. Optionally the host can memoize `list()` for the duration of one
  request.

Andrew's speed PR targets the same symptom. There is no open PR from him on
`malloydata/malloyyo` as of this writing; we reconcile before either lands (§9).

### 4.2 Compiled models: a layered `ModelCache` through Malloy's API

**Upstream (malloydata/malloy), one small PR.** In
`CacheManager.getCachedModelDef`, when the in-memory maps have no entry for the
URL, fall through to `modelCache.getModel(url)`; check each stored invalidation
key against the reader (`getInvalidationKey`); on success fill
`modelDependencies` / `modelInvalidationKeys` and return the hit. `CachedModel`
already carries the keys, so no format change. Invalidation keys are content
hashes (uuid v5 of the file text), so they are stable across processes. The
prototype of exactly this, as a subclass, passed all three checks in §3.2 #7.
Every Malloy host gets a working persistent cache from it.

**malloyyo, after the Malloy release (`/malloy-update`):** one `ModelCache`
implementation, `LayeredModelCache`, per model version, layered:

| Layer | Where | Bound | Scope | Notes |
|---|---|---|---|---|
| L1 | process memory | bytes (`MALLOYYO_MODEL_CACHE_MEMORY_MB`) | node | LRU by bytes of the serialized def |
| L2 | `$MALLOYYO_MODEL_CACHE_DIR/<model id>/<sha256(url)>.json.gz` (default `/tmp/malloyyo/models`) | bytes (`MALLOYYO_MODEL_CACHE_DISK_MB`), oldest-access first | node, survives process restart | write temp + `rename` (atomic); a corrupt or unreadable file is a miss and is deleted |
| L3 | Postgres table `compiled_models` | none needed (one row per version × entry; old versions cascade on delete) | **cluster** | read-through on L1/L2 miss, write-behind after a compile |

- **Namespaced per model version.** Every dataset's entry is
  `file:///index.malloy`, so a store keyed by URL alone would let datasets
  overwrite each other. The pool's `CacheManager` is constructed with the
  layered cache bound to its model id.
- **Why L3 is not "serverless only".** In a cluster, a publish lands on one
  node; without a shared layer every other node compiles that version on first
  touch (seconds of schema fetches per source, × nodes, against the customer's
  warehouse). With L3, a node's first touch is one row read and a gunzip.
  `MALLOYYO_MODEL_CACHE_SHARED=postgres|off`, default `postgres`.
- **Table, not a column.** Dashboards compile other entries
  (`dashboards/<name>.malloy`), so one version has several URLs. `compiled_models
  (model_id uuid → malloy_models ON DELETE CASCADE, url_hash text, url text,
  def bytea /* gzip */, bytes int, created_at)`, PK `(model_id, url_hash)`,
  insert `ON CONFLICT DO NOTHING`. `malloy_models.compiled_model_def` is dropped
  in a **later** release than the one that stops reading it (the 0014 lesson in
  CLAUDE.md).
- **Single-flight per node.** A `Map<model id + url, Promise>` around the first
  `loadModel` of a version on this node, so 32 concurrent cold requests compile
  once (finding 8). Cross-node, at most one compile per node, and publish
  pre-warming makes even that rare. Not worth a distributed lock in v1.
- **Publish warms it.** After activation, publish compiles each dataset's entry
  through the serving path (same reader, same sandboxed config) and writes
  L1/L2/L3. Best-effort: a warm failure logs and never fails the publish.
- **Drafts** (`<model id>:draft:<id>:<version>` keys) use L1 only.
- **Retire:** `src/lib/model-cache.ts`'s `_modelDef` / `_loadModelFromModelDef`
  path, `model-cache.pin.test.ts`, the `MODEL_DEF_CACHE` flag, `L1_MAX`.

Identity never enters a compiled model: givens ride on the per-request Runtime
(`runtimeFrom`), so one cached def serves every user.

### 4.3 Connections: a process-wide registry, leased per request

The pool stops being "N whole runtimes per model version". It becomes two
things with different lifetimes:

- **`ModelHandle` per model version** (replaces `RuntimePool`): the file map, the
  config JSON, the layered `CacheManager`, the finalized-givens set. Cheap,
  holds no sockets, and is LRU'd by bytes of its file map. Dropping it never
  closes a connection.
- **`ConnectionRegistry` per process**: connection key → a small pool of live
  `Connection` objects ("slots").

**Per request:** build a fresh `MalloyConfig` from the handle's config JSON
(cheap; it opens nothing until a lookup) and `wrapConnections()` it so the
first lookup of each connection name **leases a slot** from the registry, and
the end of the request returns every lease. `config.shutdown('close')` at the
end then closes nothing shared (§3.2 #14). The Runtime is built per request as
today, carrying the asker's givens.

**Connection key** = connection name + sha256 of the connection's resolved
settings: after `{"env": …}` references are filled in (`configEnvOverlay`),
**before** the sandbox options are added. The name is in the key because
compiled models and the schema cache refer to connections by name. If computing
the resolved entry needs Malloy internals (`resolveCompiledEntry`), add a small
public API upstream rather than reaching in (§9).

**Scope of sharing:**

- **Remote warehouses** (BigQuery, Postgres, MySQL, Snowflake, Trino): shared
  across every dataset on the node. Same settings ⇒ same client; identity is on
  the Runtime, not the connection.
- **DuckDB**: shared only for byte-identical entries **within one repo**.
  setupSQL builds state on the connection (ATTACH, views, secrets), and temp
  tables would be visible across datasets, so the per-repo sandbox (#211) stays
  the security boundary. The key additionally includes the repo id, and the
  scratch directory is derived from the key (`<root>/<sha(key)>`) instead of a
  fresh `mkdtemp` per build. Because DuckDB's own share key includes the
  sandbox setupSQL and allowed directories, slots with the same key then share
  one `DuckDBInstance` (`activeDBs`) with N connections into it: one buffer
  pool, one `memory_limit`, which is the right shape for DuckDB.
- **The no-config fallback** (in-memory DuckDB or `md:`) is the same for every
  such dataset; it shares within a repo in v1.

**Slots per key.** Drivers differ (finding 11): DuckDB and MySQL serialize
queries per object, Postgres opens a client per query, Snowflake pools
internally, BigQuery/Trino are concurrent HTTP clients. The uniform rule that
is correct for all of them: a key has up to `cap` slots, one in-flight request
per slot. `cap` comes from the repo's `malloy-config.json` per connection
(today's provisional `poolSize`, moved onto the connection entry so it can
differ per warehouse), default `MALLOYYO_CONNECTION_SLOTS` (8). It is the
number a customer sets to protect their warehouse: a cluster opens at most
`nodes × cap` to it.

**Lifecycle of a slot:**

```
          lease                      MALLOYYO_CONNECTION_IDLE_SECONDS (60)
 (new) ──────────▶ ACTIVE ──return──▶ WARM ───────────────────────────────▶ IDLE
                     ▲                  │                                     │
                     └──────lease───────┘◀────────────lease (reattach)────────┘
                                                                              │
             MALLOYYO_CONNECTION_CLOSE_SECONDS (900), or over budget (LRU)    ▼
                                                                           CLOSED
```

- **WARM → IDLE** calls `connection.idle()` (what `shutdown('idle')` does per
  connection): releases sockets and file locks, keeps the object and its schema
  cache. A no-op for in-memory DuckDB (finding 10), which is fine: it holds no
  socket.
- **→ CLOSED** past the long idle period, or when the process is over
  `MALLOYYO_MAX_CONNECTIONS` (default 256): close the least-recently-used
  **non-leased** slot anywhere in the process. A leased slot is never closed.
  If every slot is leased, a new key waits (below) rather than evicting.

**Waiting, deadlines and shedding** (fixes 4a–4c):

- A request that finds its key at `cap` (or the process at budget with nothing
  evictable) queues FIFO per key with a deadline
  (`MALLOYYO_POOL_WAIT_SECONDS`, default 30). On expiry it fails with an error
  that names the dataset: *timed out after 30s waiting for a free connection to
  dataset 'sales/orders': all 8 are busy. Try again shortly.*
- A returned slot goes to the head of its key's queue first, always.
- A failed slot build frees its slot and starts a build for the next waiter.
- If a key's queue is already `MALLOYYO_MAX_QUEUED` deep (default 4 × cap), new
  requests fail immediately with the same "busy" error instead of piling up.
  Fast rejection beats a timeout a client will retry into.
- Query execution keeps its existing per-query timeouts; the lease is returned
  in a `finally`, so a thrown or timed-out query never leaks a slot.

**DuckDB resources.** Every sandboxed DuckDB entry gets `threads` and
`memoryLimit` from a process budget unless the repo config sets them:
`MALLOYYO_DUCKDB_MEMORY_MB` (default: 50% of the cgroup/host memory) divided
across live DuckDB **instances** (not slots, which share one), floored at a
minimum, and `threads` = `MALLOYYO_DUCKDB_THREADS` (default: cores ÷ 2, min 1).
This fixes finding 9 and is the main thing that makes high concurrency on
DuckDB safe rather than an OOM.

### 4.4 Cluster operation

What each node holds is a cache; what must agree across nodes lives in
Postgres.

| State | Where | Cluster behavior |
|---|---|---|
| catalog | Postgres | identical on every node |
| compiled models | L1/L2 per node, L3 shared | a cold node reads L3, never compiles a published version |
| connections | per node | budget is per node; warehouse load is `nodes × cap` per key |
| app DB pool | per node (`max: 10`) | `nodes × 10` to the app DB: put a pooler in front (Neon's pooled endpoint, PgBouncer) for large clusters; make `max` a setting |
| migrations | Postgres advisory lock | already serialized |
| MCP sessions | none (stateless) | no stickiness needed |

The load balancer may send any request to any node. Health checks keep using
`/api/healthz` (no I/O) and never the deep route.

### 4.5 Small fixes (independent)

- `latestModel` selects only the columns callers use; never
  `compiled_model_def` or `source` unless asked.
- `repo-files.ts` `views` and `indexes`, and `dashboards/bundle.ts`'s cache:
  LRUs bounded by bytes (`MALLOYYO_REPO_CACHE_MB`, one budget for all three).
- Postgres connections: consider upstream registering `PooledPostgresConnection`
  (or a `pool: true` option) so a slot reuses sockets. Today each query pays a
  handshake regardless of anything in this design (finding 11).

### 4.6 Observability

One structured log line per request with: catalog source (`stored` /
`computed`), model cache result by layer (`l1` / `l2` / `l3` / `compiled`) and
compile ms, lease wait ms, slots opened / idled / closed, queue depth at enqueue.
Periodic (60 s) gauges per node: open slots by key, waiting requests, L1/L2
bytes. These answer the "when it is slow" table in §5.

## 5. Theory of operation

*This section is the product doc. It moves into `docs/` (and `docs/architecture.md`
links it) when the code matches it.*

A Malloyyo server answers a query from three things it keeps warm: **the
catalog, the compiled model, and a connection.** Each has its own cache with
its own lifetime, so losing one never costs the other two, and none of them is
needed for correctness on any particular server: a cluster of servers behind a
load balancer behaves like one.

**The catalog** is what `list_sources` shows: each dataset's description and its
exported sources. It is computed once, when a model version is published, and
stored with that version. Listing reads it from the database and never compiles
a model or opens a connection. Listing costs the same with 3 datasets or
3,000, and a model that fails to compile still lists.

**Compiled models.** Compiling means parsing the model's files and fetching the
schema of every table it reads, which on a remote warehouse can take seconds
per source. A model version never changes (a new push is a new version), so a
compiled model is never invalidated, only evicted when space runs out. It is
kept in up to three layers, checked in order: memory, then local disk
(`/tmp/malloyyo/models`; survives a process restart), then the shared database
(so a new or restarted server never recompiles a published version). On every
hit, Malloy checks each of the model's files against a content hash; a stale or
corrupt entry is a miss and is recompiled. Publishing warms all three layers.
On one server, many requests for a cold model wait for one compile.

**Connections.** A connection is a live client for one database: a DuckDB
instance, a Postgres or MySQL client, a BigQuery or Snowflake client. Requests
share connections that would be identical: same name, same settings after
`env` values are filled in. Remote warehouses are shared across every dataset on
the server; DuckDB connections only within one repo, because DuckDB setup SQL
builds state on the connection. Each connection name has a number of slots, one
running query per slot. That number is set per connection in
`malloy-config.json` and caps what a cluster can open against your warehouse at
servers × slots.

A request leases the slots it uses and returns them when it finishes. An unused
slot is first **warm** (ready instantly). After a short idle time it goes
**idle**: sockets and file locks are released but the client and its schemas are
kept, and the next request reconnects without re-fetching anything. After a
longer idle time, or when the server is over its connection budget, it is
**closed**, least recently used first. A slot in use is never closed.

A request that can't get a slot within the wait limit fails with an error that
names the dataset. A request that arrives when the queue for its connection is
already full fails immediately with the same error. No request waits forever.

**DuckDB** gets a share of the server's memory and cores rather than DuckDB's
default of most of the machine per instance, so many concurrent DuckDB queries
slow down instead of exhausting memory.

**What a query does:**

1. Resolve the dataset and its active model version (from the catalog).
2. Get the compiled model: memory, then disk, then the shared database, else
   compile once and write all three.
3. Lease a slot for each connection the query uses.
4. Build a per-request runtime carrying the asker's identity (givens) and run.
5. Return the slots.

**Identity and isolation.** The asker's identity rides on the per-request
runtime, never on a connection or a cached model. Sharing a connection shares a
database client, not who is asking. Each repo's DuckDB connections keep their
own sandbox directory: a model can read its own scratch space and remote URLs,
not the server's files or another repo's.

**When it is slow,** the logs say which layer: a high compile count means the
model cache is smaller than the working set; many connections opened means the
budget or idle times are too tight; long lease waits mean the slots for that
connection are too few for the concurrency.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `MALLOYYO_MAX_CONNECTIONS` | 256 | open slots per server, all connections |
| `MALLOYYO_CONNECTION_SLOTS` | 8 | slots per connection when the repo config doesn't say |
| `MALLOYYO_CONNECTION_IDLE_SECONDS` | 60 | warm → idle |
| `MALLOYYO_CONNECTION_CLOSE_SECONDS` | 900 | idle → closed |
| `MALLOYYO_POOL_WAIT_SECONDS` | 30 | longest a request waits for a slot |
| `MALLOYYO_MAX_QUEUED` | 4 × slots | waiting requests per connection before shedding |
| `MALLOYYO_MODEL_CACHE_MEMORY_MB` | 512 | L1 |
| `MALLOYYO_MODEL_CACHE_DIR` | `/tmp/malloyyo/models` | L2 location |
| `MALLOYYO_MODEL_CACHE_DISK_MB` | 2048 | L2 |
| `MALLOYYO_MODEL_CACHE_SHARED` | `postgres` | L3: `postgres` or `off` |
| `MALLOYYO_DUCKDB_MEMORY_MB` | 50% of memory | split across DuckDB instances |
| `MALLOYYO_DUCKDB_THREADS` | cores ÷ 2 | per DuckDB instance |
| `MALLOYYO_REPO_CACHE_MB` | 256 | repo zips, views and dashboard bundles |

## 6. Rollout

Each step is its own PR, green on `bash scripts/preflight.sh`, and each leaves
the system better on its own.

| # | PR | Needs | Fixes | Tests |
|---|---|---|---|---|
| 1 | **Pool: no hangs.** Move `RuntimePool` to `src/lib/runtime-pool.ts`; release serves waiters first even while draining; a failed build pumps the queue; `acquire()` deadline naming the dataset; queue cap. | — | 4a–4c | `runtime-pool.test.ts`: the three repros in §10 flip from HUNG to settled, plus timeout message, FIFO order, no slot leak on factory failure |
| 2 | **Catalog from publish.** `malloy_models.catalog`, publish write, two-query `list()`, backfill. Reconciled with Andrew's PR. | migration | 1, 2, 6 | engine-level `list()` test with a stub host asserting zero compiles; `test:hosted` publish → list round trip; backfill-once |
| 3 | **Small fixes.** `latestModel` columns; byte-bounded repo/bundle caches. | — | 5, 6 | LRU-by-bytes unit tests |
| 4 | **Malloy: `CacheManager` fall-through** (malloydata/malloy). | Malloy release | 7 | upstream unit test: populated `ModelCache`, fresh manager → hit; changed file → miss |
| 5 | **Layered model cache.** `/malloy-update`; L1/L2/L3 `ModelCache`, `compiled_models` table, single-flight, publish warm; retire `MODEL_DEF_CACHE` and the internal APIs. | 4, migration | 5, 7, 8 | disk atomicity/corruption/byte-eviction; restart → 0 schema fetches; single-flight under 32 concurrent; cross-version isolation |
| 6 | **Connection registry.** `ModelHandle` + `ConnectionRegistry`, `wrapConnections` leasing, keys, slots, warm/idle/closed, budget, DuckDB resource split, scratch dir from key. | 1 | 3, 9, 11 (partly) | registry unit tests with fake connections (never closes leased; LRU idle eviction; budget); DuckDB sharing stays within a repo; isolation test that repo A cannot see repo B's scratch |
| 7 | **Docs + drop `compiled_model_def`.** Move §5 into `docs/`, link from architecture; drop the column one release after 5. | 5 shipped | — | migrate tests |

**Load test before and after** (becomes `scripts/load-test.ts`): an instance
with ~50 datasets across ~5 repos; measure `list_sources` p50/p99, `query`
p50/p99, 32 and 256 concurrent `query` calls on one node, then on a 3-node
cluster with a node restarted mid-run. Pass = flat listing, zero hangs, no
recompiles after the first per version per cluster.

## 7. Alternatives considered

- **Keep count-based pools, raise `MAX_POOLS`.** Removes the cliff only until
  the next N; connections still die with their compiled models; still a pool
  of runtimes per version, so connections are multiplied by versions.
- **Cache `list()` in memory per node.** Fast on a warm node, but N compiles on
  every cold node and every eviction, and a cache to invalidate on publish
  across a cluster. The catalog is immutable per version; storing it is simpler
  and exact.
- **Keep #58's Postgres column with internal APIs.** Works, but couples
  malloyyo to Malloy internals, has no disk layer, holds one entry per version
  (dashboards miss), and fixes nothing for other Malloy hosts.
- **One `Connection` object per key for every driver.** Correct for HTTP
  drivers, but DuckDB and MySQL serialize per object, so it would cap those at
  one query at a time. Slots are uniformly correct.

## 8. Risks

- **Shared remote connections and per-connection state.** If a warehouse
  connection's setupSQL sets session state that depends on the dataset, sharing
  across datasets would leak it. Mitigation: setupSQL is part of the resolved
  settings, so differing setupSQL means a different key. Identical setupSQL is
  by definition identical state.
- **Disk layer on hosts with a small or shared `/tmp`.** Bounded by bytes and
  configurable; a write failure degrades to memory + L3.
- **L3 size.** Several MB per version × entry. Rows cascade with model versions;
  a retention policy for inactive versions can come later.
- **Ordering of the column drop.** As with 0014: stop reading in one release,
  drop in a later one.

## 9. Decisions needed

1. **Targets.** Are §2's numbers the right bar (3,000 datasets per instance;
   256 concurrent queries per node; N-node cluster), or is there a specific
   customer shape to size for?
2. **L3 default.** Postgres shared layer on by default (my recommendation, for
   clusters), or off unless configured?
3. **Andrew's PR.** If it memoizes `list()` per node, does it land first as a
   stopgap, or do we go straight to the stored catalog?
4. **Per-connection slots in `malloy-config.json`.** Field name and placement
   (on each connection entry, e.g. `"slots": 8`) and whether it replaces the
   top-level `poolSize`. This touches the repo config contract, so it's yours.
5. **Malloy upstream scope.** Beyond the `CacheManager` fall-through: a pooled
   Postgres registration, and a public "resolved connection entry" API for the
   connection key?
6. **Shed behavior.** Is an immediate "busy, retry" error acceptable to MCP
   clients, or should the queue only ever time out?
7. **Disk on malloyyo.com hosts.** How large `/tmp` is and whether it survives a
   container restart there (sets the L2 default).
8. **Cross-repo DuckDB sharing.** Stay "no" for v1?

## 10. Evidence: how to reproduce

Experiments run in this session against `@malloydata/malloy@0.0.431` and
`@malloydata/db-duckdb@0.0.431` (the lockfile's versions), outside the repo.

**Pool hangs (4a–4c).** `RuntimePool` copied verbatim from `src/lib/malloy.ts`;
each test races the promise against a 500 ms timer:

```ts
// A: drained while saturated
const pool = new RuntimePool(async () => entry(), 2);
const a = await pool.acquire(), b = await pool.acquire();
const third = pool.acquire();
await pool.drain(); pool.release(a); pool.release(b);
// third: HUNG

// B: queued behind a failing build (max 1; first build throws)
const first = pool.acquire(), second = pool.acquire();
// first: rejected; second: HUNG

// C: a lease that never returns (max 1)
await pool.acquire();
// pool.acquire(): HUNG (no deadline)
```

All three reproduce: 3 of 3 assert `HUNG`.

**Persistent cache (7)**, a DuckDB model with an inline SQL source and a CSV
table, `wrapConnections` counting `fetchSchemaFor*` calls, and a `ModelCache`
backed by a `Map` that outlives each `CacheManager` (a simulated restart):

| Run | Schema fetches |
|---|---|
| cold compile, stock `CacheManager` | 2 |
| new stock `CacheManager`, same populated store | **2** (store ignored) |
| new fall-through `CacheManager`, same store | **0** (rows correct) |
| file edited, fall-through | 2 (correctly recompiled) |

**`shutdown('idle')` (10)**: query, `shutdown('idle')`, query again on the same
config: `idle()` called once, `close()` 0, second query correct.

**Shared connection (14)**: one connection handed to two configs via
`wrapConnections`, each `shutdown('close')`: the shared connection's
`close()` was called 0 times.

**DuckDB defaults (9)**: `current_setting('memory_limit')` = 10.6 GiB,
`threads` = 4 on a 4-core, 17 GB container; 40 idle in-memory instances added
≈ 0 MB RSS.
