# Governance

**The semantic model is the fence.** An agent composes over what the model
publishes. It cannot reach past it into the warehouse — no imports, no raw
tables, no raw SQL, no new connections.

This is not a prompt instruction that a clever question can talk its way around.
It is the Malloy compiler refusing to compile the construct.

---

## Restricted mode

Every query from the explore surface compiles in Malloy's **restricted mode**.
Forbidden constructs are rejected at compile time with the error code
`restricted-construct-forbidden`, and the failing result carries the
`explore/restricted-queries` help topic inline.

| Rejected | Example that fails | Why |
|---|---|---|
| `import` | `import "sources.malloy"` | Pulls in a file the published surface didn't offer |
| `given:` declarations | `given: X :: number is 1` | New parameters are the author's to declare; `$NAME` references are fine |
| `connection.table(...)` | `duckdb.table("orders")` | Direct table access, bypassing the model |
| `connection.sql(...)` | `duckdb.sql("SELECT 1 as x")` | Raw SQL against the connection |
| `##!` compiler flags | `##! experimental.givens` | Changes how the query itself is compiled |
| `sql_*` functions | `sql_number("1+1")` | Emits caller-supplied SQL directly |
| `name!type(...)` raw SQL | `x is anything!number(distance)` | The same thing, in expression form |

## What is allowed — and it's generous

The fence is around the *warehouse*, not around your thinking. Inside the model's
published surface you have full compositional freedom:

- **Everything the model defines** — its sources, dimensions, measures, views,
  joins, and named queries. `describe_source` shows exactly what's there.
- **Run a named query and refine it** —
  `run: top_carriers + { where: dep_year = 2024 }`.
- **Define your own dimensions, measures, sources, and joins**, as long as they
  are *derived from the model's sources*. You are not limited to the author's
  fields; build new ones out of them.
- **Reference the model's `$NAME` givens** and supply values through the `givens`
  map on the `query` call. Use `execute:false` to discover which a query needs.
- **Use a model field that was itself defined with raw SQL.** The author vouched
  for the model's own definitions; restricted mode governs the query text you
  submit, not the model you submit it against.

## When you hit the fence

The fix is never to work around it. Two legitimate moves:

1. **Express the answer in terms of what the model publishes** — a derived
   source, a join, a computed dimension, a new measure over existing ones.
2. **Tell the model's author what's missing.**

A question the model genuinely cannot answer is not a failure of the query. It is
the clearest possible specification for the next version of the model, which is
why the questions page is worth reading.

## The same gate, everywhere

Restricted mode is not an MCP-only feature. Every path that runs Malloy text
supplied by something other than the model author goes through it:

- **Dashboard suggestion and typeahead queries** — the `# suggest {…}` tag's
  server-side narrowing runs as restricted Malloy.
- **Ad-hoc queries from a custom dashboard component** — `useQuery({ malloy })`.
- **`runData()`** — the frame runtime's escape hatch for a component that needs
  raw rows.

A dashboard may also run a **named query the model publishes** by name, which
needs no gate — it is the model's own code.

---

## Export discipline

`export { … }` in `index.malloy` decides the published surface. Without an
`export` statement, everything you define is public — every base source, every
staging intermediate.

```malloy
import "users_base.malloy"
import "orders_base.malloy"

source: users is users_base extend {
  join_many: orders is orders_base on id = orders.user_id
}

export { users }
```

Export is what `list_sources` publishes and what a bare source name resolves
against, so it decides what an agent discovers and reasons about. Treat it as
**curation, not secrecy**: it shapes the surface an agent works from, but it is
not a security boundary against a caller who already knows an internal name.
Anything that must not be reachable at all belongs outside the model's
connection, not merely outside its `export` list.

## Visibility is separate

Restriction decides *what Malloy compiles*. Visibility decides *which models you
can address at all*: a dataset is public — every signed-in user — or private to
its owner, and only `ready` datasets are servable.

**"Unknown model" and "not visible to you" return the same message, deliberately.**
A probe must not be able to tell a dataset that doesn't exist from one it isn't
allowed to see; distinguishing them would leak the existence of private datasets
to anyone willing to guess names.

## Publish is compile-gated

A model that doesn't compile never goes live. The publish endpoint compiles the
submitted files before it writes anything; on failure it records the error on the
dataset and stores **no** model version. The previous version keeps serving.

So *latest = live = valid*, always. There is no state in which the MCP endpoint
is serving a model nobody could compile.

## The byte budget

Results are byte-budgeted per response. When rows exceed the budget they are
truncated **from the end** — the response says so and hints at what to do — which
means the **query's own ordering decides which rows survive**.

That is the reason ranking, top-N, and member selection belong in Malloy rather
than in client code. An unordered query that overflows the budget doesn't return
a sample; it returns whichever rows the engine happened to emit first.

## The dashboard sandbox

A **custom** dashboard is repo-authored code, and repo-authored code is
untrusted. It runs in an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`, so the document lives in an **opaque origin**: no access to
the parent DOM, no app-origin cookies, and a same-origin `fetch` that carries no
session. Its bundle is fetched with a short-lived capability token scoped to that
viewer and that dashboard rather than with the session cookie. Its only channel
to the trusted page is `postMessage` — and every query it sends back through that
channel lands on the restricted gate above.

A **tag-only** dashboard has no author code at all, so it renders directly in the
trusted page.

→ [`../dashboard-iframe-security.md`](../dashboard-iframe-security.md)

---

**See also:** [What the server serves](server-surfaces.md) ·
[Testing a model](testing.md) — `malloyyo test` runs this same restricted
surface locally, so you find the fence before your users do.
