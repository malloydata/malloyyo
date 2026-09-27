# Multi-tenant givens

A dataset can be scoped to whoever is asking: the model declares
`MALLOYYO_EMAIL`, filters on it, and every query against that dataset returns
only that person's rows.

*(The name is provisional, and the plumbing takes a set — `datasets.required_givens`
is an array, and every check iterates it — so a rename or a second name is a
value change, not a code change.)*

The hard part is not making it work. It is making it impossible to turn off by
accident. Everything below was measured against a real compile.

## The shape

```malloy
##! experimental { givens }
given:
  MALLOYYO_EMAIL :: string is ''

source: orders is ... extend { where: owner_email = $MALLOYYO_EMAIL }
```

Filter on the **source**, not in each query. A `where:` on the source propagates
to every query over it — including queries written later, and ad-hoc ones an
agent composes — and, as below, that is also what makes the safety gate free.

## Three rules, no new config

### 1. The dataset records what it requires, derived from the model

`datasets.required_givens text[]`, empty by default. On publish — and on GitHub
refresh, which is how most models actually arrive — compile and read the
`MALLOYYO_*` givens the model declares:

| dataset has | model declares | outcome |
| --- | --- | --- |
| nothing | nothing | ordinary dataset, nothing attached |
| nothing | `MALLOYYO_EMAIL` | **record it** — the dataset is now scoped |
| `MALLOYYO_EMAIL` | `MALLOYYO_EMAIL` | publish |
| `MALLOYYO_EMAIL` | nothing | **refuse the publish**, naming it |

Creating a dataset with the given in it marks the dataset; nobody sets a flag.
A later commit can *add* scoping and can never take it away — clearing a
requirement is an explicit admin action, not a side effect of a push.

This is the primary defense, and it fires before anything is ever served.

### 2. At serve time, attach unconditionally

The values for `required_givens` go on the Runtime, and those names go into
`finalizeGivens` — injected server-side, into the config JSON, before
`new MalloyConfig`. Never the model author's to write.

**Not** "attach if the model declares it." That branch is the one that fails
open, and it is worth being concrete about why:

| | attach only if declared | attach always |
| --- | --- | --- |
| as published | (impossible — see below) | `[{who: a@b.com}]` |
| declaration removed | `[{a@b.com}, {c@d.com}]` ← **leak** | REFUSED — `unknown given` |

Bottom-left is a developer deleting the `given:` and the `where:`. The
conditional version stops attaching the identity and serves everyone's rows.
Attaching unconditionally means the same edit takes the dataset **dark**
instead.

The top-left cell is impossible because `finalizeGivens` filters the name out of
`Model.givens`, so a serving runtime cannot see the declaration to branch on it.
The mechanism refuses to let you write the unsafe version.

Core also fails closed on its own when a finalized given has no value:

```
Finalized given 'MALLOYYO_EMAIL' has no resolved value. It must be supplied
in `givensPath` or in the Runtime constructor's `givens`.
```

### 3. A usage gate at query time

Publish-time checks cannot see an ad-hoc query, and a declaration is not a
filter. `PreparedQuery.givens` reports what a query **actually references**:

```
filters on it           ["MALLOYYO_EMAIL"]
declared, never used    []            ← the accidental refactor, visible
used cosmetically       ["MALLOYYO_EMAIL"]
```

So: on a dataset with `required_givens`, refuse any query that does not
reference each of them.

Because a source-level `where:` propagates, the normal idiom passes for free —
row one above is the query `mine -> { select: who }`, which never mentions the
given. What stands out is a query against a source nobody filtered. Live, on a
scoped dataset:

```
run: my_names -> { aggregate: n is count() }        200   414,396 rows
run: baby_names_table -> { aggregate: n is count() } 400   "…this data is scoped by
                                                            this given, and the query
                                                            never references it."
```

The gate lives in `executeMaterialized`, which every engine run passes through,
and is repeated in the two app paths that compile a query themselves for the
ModelDef cache. Three places, because a path that skipped it would serve
unscoped rows while looking exactly like one that didn't.

**One wrinkle, load-bearing:** core hides finalized names from `Model.givens`
but NOT from `PreparedQuery.givens`. That is what makes this gate readable at
all — and it also means a dashboard would render a control for the identity, so
the app filters the CONTROLS itself (`visibleGivenSpecs`). The docs say both are
filtered; measured, only the first is. If that is a bug and gets fixed, the gate
sees `[]` and refuses every query on a scoped dataset: dark, not open.

## What this catches, and what it does not

Caught:

- the `given:` deleted, by publish;
- a source extracted from a filtered one without the `where:`, by the usage gate;
- a brand-new unfiltered source, by the usage gate;
- an ad-hoc MCP query against an unfiltered source, by the usage gate;
- anything that slips past all of the above — core throws, dataset goes dark.

**Not** caught, and worth saying out loud:

- **cosmetic reference** — `select: e is $MALLOYYO_EMAIL` counts as usage.
  Only execution distinguishes it: the same query under two identities gives
  `differs` when filtered and `IDENTICAL` when not. A differential run at
  publish would catch it, at the cost of real query execution and false
  positives on genuine reference data. Worth adding later behind the same flag,
  with a per-query opt-out so deliberate exceptions appear in the diff.
- **a widened filter** — `where: owner = $X or is_public`. Usage passes, results
  still differ. Nothing mechanical catches this; it is a review question.

## Local development

No config. The CLI computes the declared `MALLOYYO_*` set from the model and
requires a matching environment variable for each:

```bash
malloyyo lint                                          # compiles; needs no identity
MALLOYYO_EMAIL=you@example.com malloyyo dashboard dev  # running does
```

Missing one is a clear failure naming the variable, not an empty dashboard.
Only the paths that RUN a query demand it: `lint`, artifact discovery and the
bundler all compile without ever asking who is looking, and a repo with no
`index.malloy` or a model mid-edit resolves to "no identity needed" rather than
failing on the way past.

Locally the names are supplied but **not finalized** — `finalizeGivens` lives in
the config file, and that file is the author's. So `?MALLOYYO_EMAIL=` in the dev
URL still overrides, which is the right local affordance (look at the page as
someone else) and exactly what a published instance forbids. What does match
production is the gate.

This replaces the `malloyyo.test_givens` block PR #184 added to
`malloy-config.json`. That block worked, but its value was committed, which
meant a rule — "the server must never read this" — enforced by nothing but a
comment in two files, and an open invitation to commit a real address. The
environment needs no rule: there is nothing in the repo to read.

Malloy's own `givensPath` (a JSON file named by the config, optionally via
`{"env": "VAR"}`) would also work, and the CLI already supplies the `configURL`
it needs. It is a file to create on clone instead of a variable to set, and its
values must match the model's declared set exactly — extras throw. The
environment is simpler for one or two names.

## Implementation notes

- **Pool `MalloyConfig` + `CacheManager` per model, not `Runtime`.** A Runtime
  is a givens map, a finalized-name set, and a pointer to the config:
  1000 of them cost 1ms, while the config owns the connections. Per-request
  Runtimes are what make per-request identity possible, and they cost nothing.
  Sharing the compiled model across tenants is safe — `ModelCache` stores
  `ModelDef`, which carries declarations; binding happens at `getSQL`/`run`.
- **The config-less path must go.** `buildRuntimeWithReader` drops to
  `SingleConnectionRuntime` when a model ships no `malloy-config.json`, and that
  takes no config, so it cannot carry `finalizeGivens`. Two of seven production
  datasets are on it, both legacy single-`source` models with zero file rows;
  every repo-backed model has a config. Synthesize one instead, as the CLI
  already does — verified against the real GCS parquet, including
  `enableExternalAccess` and a `/tmp` spill directory. MotherDuck is the one
  part not verifiable without a token; exercise it against `motherduckyo`
  before the switch.
- **Delete** `resolveHostGivens`, `withoutHostGivens`,
  `missingHostGivensMessage`, the `host-given-unavailable` problem, and
  `test_givens`. Core covers the lock, the introspection filter, and the
  fail-closed case; the dataset flag covers the rest.
- **Keep** refusing `MALLOYYO_*` names we do not supply, on both publish paths.
- Per-request Runtimes also retire the `withModelRuntime` monkey-patch, where a
  leased runtime's `loadModel` is shadowed and restored so the pooled runtime
  is not contaminated. Nothing to contaminate when it is not shared.

## A constraint this creates

Nothing in the app caches query results today — the only `cacheScope` is the MCP
panel shell, already `private`. The moment anything does, the identity must be
in that key. Nothing enforces this.

## Notes for Michael

- **`finalizeGivens` is config-file-only.** A host that wants to lock a name has
  to inject it into the author's config JSON before constructing `MalloyConfig`.
  A constructor option beside `givens:` would let a host lock a name without
  rewriting a file it does not own.
- **`Model.givens` and `PreparedQuery.givens` disagree about filtering.** The
  docs say both hide finalized names. Measured: `Model.givens` hides them,
  `PreparedQuery.givens` does not. The usage gate above depends on that
  difference, so we would rather it were intended than incidental. (If it is a
  bug and gets fixed, the gate sees `[]` and refuses every query — dark, not
  open, which is the right direction to fail.)
- **Supplying a runtime given the model does not declare is fatal.** That is
  what makes the unconditional attach safe, so we depend on it — but it does
  mean a host with an ambient identity cannot attach it blindly across a mixed
  fleet. Deliberate, or worth a "supply if declared" runtime-layer option?
- **A missing `givensPath` file reports as an internal compiler error**
  ("likely a Malloy bug — please file an issue") when it is a missing user file.
