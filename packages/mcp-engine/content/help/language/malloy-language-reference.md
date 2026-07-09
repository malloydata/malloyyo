<!-- Copied from malloy-cli (jrtipton/malloy-cli) skills/malloy-language-reference.md on 2026-06-11.
     Deliberate temporary fork — converge when the engine is extracted to @malloydata. -->
---
description: Malloy language reference — concepts, syntax, compilation model. Load this before writing or reviewing Malloy code.
---
# Malloy Language Reference

Malloy is a semantic data modeling and query language. It compiles to SQL and runs against existing database engines (DuckDB, BigQuery, Snowflake, PostgreSQL, MySQL, Trino, Presto). It is not a SQL wrapper or abstraction layer — it has its own type system, scoping rules, expression semantics, and compilation pipeline.

Malloy is designed around how humans think about data, not how data computations are mechanically accomplished. SQL is oriented around the machine — you specify joins, group-by columns, subqueries, and window functions in terms of what the database needs to do. Malloy is oriented around the analyst — you describe relationships, name computations, and compose questions in terms of what the data means. Malloy bridges the gap between these two by compiling the human-oriented description into correct, efficient SQL.

A core design principle is that **most queries are themselves designing a new semantic model.** Formulating a question about data — choosing what to group by, what to aggregate, what to nest — is inherently an act of defining a new way to look at that data. Malloy is built around this idea: the output of every query is not just a result set but a new source with its own schema, and data comprehension is an ongoing iterative process where later stages want not only the data from a previous stage but how that data came into being. This is why query output carries metadata, why queries can be used as sources, and why views and pipelines compose naturally.

## Documents and Statements

A Malloy file (`.malloy`) is a sequence of statements, optionally separated by semicolons. There are five statement types:

- **`import`** — import sources and queries from another `.malloy` file
- **`source:`** — define a named, reusable data source with its schema and extensions
- **`query:`** — define a named query (source + view) for reuse
- **`run:`** — execute a query (the "do it now" statement)
- **`given:`** — declare model-level parameters supplied at run time (experimental, see Givens)

```malloy
import "shared_model.malloy"

source: flights is duckdb.table('flights.parquet') extend {
  measure: flight_count is count()
}

query: carrier_summary is flights -> {
  group_by: carrier
  aggregate: flight_count
}

run: carrier_summary
```

Comments use `//` or `--` (both are line comments).

## Sources

A **source** is anything you can hand a SQL database and get a schema back — a table name, a SQL SELECT, or the output of another Malloy query. The columns in that schema become the source's initial fields (all dimensions).

```malloy
source: flights is duckdb.table('flights.parquet')
source: limited is duckdb.sql("""SELECT * FROM flights LIMIT 100""")
source: carrier_facts is carrier_summary   -- a query used as a source
```

What makes sources central to Malloy is **extension**. The `extend` block lets you layer on dimensions, measures, views, joins, filters, primary keys, field restrictions, and renames. These extensions travel with the source — any query against it gets them for free.

```malloy
source: flights is duckdb.table('flights.parquet') extend {
  primary_key: id

  dimension: distance_km is distance * 1.609344

  measure:
    flight_count is count()
    total_distance is sum(distance)

  join_one: carriers with carrier
  join_one: origin_airport is airports on origin_airport.code = origin

  where: dep_time > @2001

  view: by_carrier is {
    group_by: carrier
    aggregate: flight_count, total_distance
  }
}
```

Sources can extend other sources, creating a refinement chain:

```malloy
source: ca_flights is flights extend {
  where: origin.state = 'CA'
}
```

Field access control uses `accept:` (allowlist) or `except:` (denylist) to restrict which inherited columns are visible. Fields can be renamed with `rename: new_name is old_name`.

## Joins

Joins are declared in the source, not reconstructed in every query. This is a fundamental design difference from SQL: the graph structure of your data is a property of the model.

```malloy
join_one: carriers with carrier                          -- FK → PK shorthand
join_one: origin_airport is airports on origin_airport.code = origin  -- explicit ON
join_many: line_items on line_items.order_id = id        -- one-to-many
join_cross: other_table on other_table.key = key         -- cross join
```

- `join_one` — the joined source has at most one row per source row (many-to-one or one-to-one)
- `join_many` — the joined source has potentially many rows per source row
- `join_cross` — a full cross product

The `with` shorthand requires the joined source to have a declared `primary_key`. All joins are left outer by default. There is no right join — Malloy's graph model doesn't need one.

**Choosing `join_one` vs `join_many`:** Ask "for a single row in the base source, can the joined source match more than one row?" If yes → `join_many`. If no (or at most one) → `join_one`. The common mistake is reaching for `join_many` when joining a *lookup or summary table* (e.g., joining an inventory snapshot to a purchase history on a wine key). Even though the joined table may have many rows overall, if each base row resolves to *at most one* joined row, use `join_one`. Use `join_many` only when the join genuinely fans out the base rows — e.g., joining line items to orders, or notes to a wine catalog.

When you reference a joined source's fields, you use dot notation: `carriers.nickname`, `origin_airport.state`. This is one of Malloy's most important abstractions: **the access path to nested data is identical regardless of how the nesting is physically stored.** An array of records embedded in a column, a `join_many` to a separate table, a record-typed column — all are navigated with the same dot notation. The SQL required to traverse these different physical arrangements varies wildly (unnesting arrays, LEFT JOINs, correlated subqueries, ARRAY_AGG), but Malloy hides all of that. You think about the logical shape of your data — "flights have carriers, carriers have a nickname" — and write `carriers.nickname`. The compiler figures out what SQL is needed to get there. This means you can restructure your physical schema (normalize a nested array into a separate table, or denormalize a joined table into a record column) without changing any of the Malloy that references that data.

## Fields

Malloy has four kinds of fields: **dimensions**, **measures**, **views**, and **calculations**.

### Dimensions

Scalar expressions — they compute a value per row. All columns inherited from a table are dimensions. Computed dimensions reference other dimensions or columns:

```malloy
dimension: full_name is concat(first_name, ' ', last_name)
dimension: is_long_haul is distance > 1000
```

### Measures

Aggregate expressions — they compute a value across a set of rows. A field is a measure when its defining expression contains an aggregate function (`count`, `sum`, `avg`, `min`, `max`):

```malloy
measure:
  flight_count is count()
  total_distance is sum(distance)
  avg_distance is avg(distance)
  pct_delayed is count() { where: dep_delay > 30 } / count()
```

**`count(expr)` counts distinct values.** Unlike SQL's `COUNT(DISTINCT expr)`, Malloy uses `count(expr)` for distinct counting. The `count(distinct expr)` form is a deprecated syntax that will produce an error. Use `count()` for total row count, `count(field)` for distinct values of that field:

```malloy
aggregate:
  total_rows is count()               -- all rows
  unique_carriers is count(carrier)   -- distinct carriers
```

Measures can be filtered inline with `{ where: ... }`, which is how you build things like "percent of flights delayed" without subqueries.

### Views

A view is a query saved into the source — a reusable transformation:

```malloy
view: by_carrier is {
  group_by: carrier
  aggregate: flight_count, total_distance
  limit: 10
}
```

Views can reference other views from the same source as a starting point, and can be extended with `+`.

### Calculations

Window functions over the grouped result. Calculations can only be defined in a query stage with `calculate:`, never in a source definition, because they depend on the output columns of the query:

```malloy
run: flights -> {
  group_by: carrier
  aggregate: flight_count
  calculate: carrier_rank is rank()
}
```

## Queries and Views

A query pairs a source with a view (the transformation). Everything after the first `->` is the view.

```malloy
run: flights -> {
  group_by: carrier
  aggregate: flight_count
}
```

### Reduction vs. Projection

Each stage of a view performs exactly one of:

- **Reduction** — uses `group_by:` and/or `aggregate:` to reduce grain. Analogous to `SELECT ... GROUP BY` in SQL.
- **Projection** — uses `select:` to pick fields without aggregation. Analogous to `SELECT` without `GROUP BY`.

These cannot be mixed in a single stage. A stage with `group_by:` cannot have `select:`, and vice versa.

### Source-level definitions vs. query-level operations

The same `name is expression` syntax defines fields in both sources and queries:

```malloy
-- In a source (reusable):
source: flights is ... extend {
  measure: flight_count is count()          -- defines a measure in the model
}

-- In a query (ad hoc):
run: flights -> {
  aggregate: flight_count is count()        -- defines the same measure inline
}
```

When used in a source, `measure:` and `dimension:` are **definition statements** — they add named fields to the source's schema. When used in a query, `group_by:`, `aggregate:`, `select:`, `nest:`, and `calculate:` are **query operations** — they specify what the query does. The field definitions are syntactically identical in both contexts, but the enclosing keyword determines the role:

| Source keyword | Query keyword | What it holds |
|---|---|---|
| `dimension:` | `group_by:` or `select:` | scalar expressions |
| `measure:` | `aggregate:` | aggregate expressions |
| `view:` | `nest:` | sub-queries |
| _(n/a)_ | `calculate:` | window functions |

This is why `measure` and `aggregate` are separate keywords. `measure:` is a *modeling* statement — "this source has a reusable aggregate computation called X." `aggregate:` is a *query* statement — "in this query, include these aggregate values in the output." A query's `aggregate:` can reference a previously defined measure by name, or define one inline. The distinction parallels the separation between defining a dimension in a source and using it via `group_by:` in a query.

### Multi-stage Pipelines

Stages chain with `->`. Each stage's output becomes the next stage's source:

```malloy
run: flights -> {
  group_by: carrier
  aggregate: flight_count is count()
} -> {
  where: flight_count > 1000
  select: *
}
```

### Refinement with `+`

The refinement operator `+` merges query operations together. It works both within a view and at the top level on a named query:

```malloy
-- Refining a view within a query:
run: flights -> by_carrier + { limit: 5 } + { nest: by_destination }

-- Refining a named query at the top level:
run: carrier_summary + { group_by: origin }   -- add origin grouping to existing query
```

When a dimension name appears as a bare reference, it expands to `{ group_by: name }`. A measure name expands to `{ aggregate: name }`:

```malloy
run: flights -> carrier + flight_count + { limit: 10 }
-- equivalent to: flights -> { group_by: carrier; aggregate: flight_count; limit: 10 }
```

For multi-stage queries, refinement semantics get more complex — but for single-stage queries, `+` straightforwardly merges operations into the stage.

### Nesting

`nest:` embeds an aggregating subquery inside a reduction. Each row of the outer query gets a subtable from the nested query. Nests can nest arbitrarily deep:

```malloy
run: flights -> {
  group_by: carrier
  aggregate: flight_count
  nest: top_routes is {
    group_by: origin, destination
    aggregate: flight_count
    limit: 3
  }
}
```

### Other query operations

- **`where:`** — filter rows (pre-aggregation). Comma-separated filters are ANDed.
- **`having:`** — filter groups (post-aggregation), like SQL's HAVING.
- **`limit:`** / **`order_by:`** — limit and sort output.
- **`extend`** — add fields or joins to a source inline within a query expression.

## Aggregate Locality (Symmetric Aggregates)

This is one of Malloy's most important features. In SQL, when you join tables and aggregate, you risk double-counting (the "fan trap"). Malloy solves this with **aggregate locality** — you specify *where in the join graph* an aggregation should be computed.

```malloy
run: flights -> {
  aggregate:
    -- avg seats weighted by number of flights (locality: source, i.e. flights)
    avg_seats_per_flight is source.avg(aircraft.aircraft_models.seats)
    -- avg seats per aircraft model (locality: aircraft_models)
    avg_seats_per_model is aircraft.aircraft_models.seats.avg()
}
```

Three syntactic forms:

- `avg(expr)` — aggregate at the current source (implicit locality)
- `joined_source.avg(expr)` — aggregate at the specified join point (explicit locality)
- `joined_source.field.avg()` — shorthand for aggregating the field at its parent source

For `sum` and `avg` (asymmetric aggregates), when the expression crosses a join boundary, Malloy *requires* explicit locality — it won't silently give you a wrong answer. For `min`, `max`, and `count` (symmetric), locality doesn't change the result, so implicit is always fine.

Malloy implements this with a technique called **symmetric aggregates** — it internally de-duplicates rows based on primary keys at the appropriate join level, so aggregations are always mathematically correct regardless of join fan-out.

## Ungrouped Aggregates

`all()` and `exclude()` allow computing aggregates at different grouping levels within a single query:

```malloy
run: airports -> {
  group_by: state, faa_region
  aggregate:
    airport_count is count()
    total_airports is all(count())                   -- ungrouped: total across all rows
    region_airports is all(count(), faa_region)       -- grouped only by faa_region
    pct_of_total is count() / all(count())
}
```

`all(expr)` removes all grouping. `all(expr, dim1, dim2)` keeps only the specified grouping dimensions. `exclude(expr, dim)` removes the specified dimension from grouping.

**Important:** `all(expr, dim)` takes the **local alias name** as defined in the query's `group_by:`, not a dotted path. If you want to partition by a joined field, alias it first:

```malloy
-- WRONG: all(count(), director.primaryName)  -- dot paths don't work here
-- RIGHT:
run: movies -> {
  group_by: director is director.primaryName   -- alias it
  aggregate:
    movies is count()
    director_total is all(count(), director)   -- reference the alias
    pct is count() / all(count(), director)
}
```

## Expressions

Malloy expressions include arithmetic, comparison, logical operators, function calls, type casts, and several Malloy-specific forms.

### Evaluation Spaces

Every expression has an evaluation space: **literal**, **constant**, **input**, or **output**. Input expressions reference source columns/dimensions. Output expressions reference the results of the current query stage (used in `calculate:`). Some functions constrain their arguments — e.g., `lag(expr)` requires an output expression, `avg(expr)` requires an input expression.

### Application and Partial Comparison

The `?` operator applies a condition to a value. Partial comparisons are conditions without a left-hand side:

```malloy
where: state ? 'CA' | 'NY'         -- state is 'CA' or 'NY'
where: distance ? > 500 & < 2000   -- distance between 500 and 2000
```

`|` is alternation (OR), `&` is conjunction (AND) within partials.

### Pick Expressions

Malloy's equivalent of CASE:

```malloy
dimension: size_bucket is
  pick 'short' when distance < 500
  pick 'medium' when distance < 1500
  else 'long'
```

### Filtered Aggregate Expressions

Any aggregate can be filtered inline:

```malloy
measure: ca_flights is count() { where: origin.state = 'CA' }
```

### Type Casting

```malloy
total_distance::string       -- Malloy type cast
name::"VARCHAR(32)"          -- database-native type cast
```

### Time Literals and Ranges

```malloy
@2003                       -- the year 2003
@2003-Q2                    -- second quarter of 2003
@2024-01-15 10:30:00        -- timestamp literal
dep_time ? @2003 to @2005   -- range comparison
now                         -- current timestamp
```

## Data Types

Malloy's type system: `string`, `number`, `boolean`, `date`, `timestamp`, `timestamptz`, `json`, and `sql native` (for unsupported database types). Compound types: `type[]` for arrays, `{ name :: type, ... }` for records, nesting arbitrarily: `{ x :: number, tags :: string[] }[]`.

## Annotations and Tags

These are related but distinct concepts.

### Annotations

Annotations are **text strings** attached to objects during compilation. They are metadata — they never affect query execution or SQL generation. An annotation starts with `#` and continues to end of line:

```malloy
# bar_chart
view: by_carrier is { ... }
```

- `#` annotations attach to the next object defined below them
- `##` annotations attach to the model (the file)
- Block annotations use `#|` ... `|#` for multi-line content (closing delimiter must match the column position of the opener)

Annotations distribute over definition lists:

```malloy
# currency
measure:           -- all three measures get the # currency annotation
  revenue is sum(amount)
  # percent          -- this measure also gets # percent
  margin is revenue / cost
  cost is sum(amount)
```

### Tags (a use of annotations)

Tags are the primary *consumer* of annotation strings. They interpret annotation text using a structured property language (MOTLY). The key distinction: **annotations are the transport mechanism (raw strings attached to objects), tags are the interpretation layer (parsed key-value properties).**

Not all annotations are tags. An annotation is just text. Tags are annotations that happen to be written in the tag property language and parsed by an application.

### Annotation prefixes (routing)

The character(s) immediately after `#` route the annotation to different consumers:

- `# ` (hash-space) — renderer tags, parsed by the Malloy VS Code extension for visualization (`# bar_chart`, `# line_chart`, `# shape_map`; `# link { url_template="https://…/$$" }` turns a field's cell into a clickable deep link — `$$` is the cell value, `field=other` links on a different (often `# hidden`) field; `# image { url_template=… }` renders it as an image)
- `##!` — compiler directives (e.g., `##! experimental.parameters`, `##! experimental.givens`)
- `#"` — reserved for documentation strings
- `#(appName)` — application-specific tags (e.g., `#(docs) hidden`)

```malloy
# bar_chart size=large        -- renderer tag: tells VS Code how to render
##! experimental.parameters   -- compiler tag: enables a feature flag
#(myApp) priority=high        -- custom app tag: ignored by renderer/compiler
```

### Tag property syntax

```
tName                         -- boolean flag (exists = true)
tName=value                   -- set property value
tName=[a, b, c]               -- array value
tName: { p1=v1 p2=v2 }       -- nested properties (replaces)
tName { p1=v1 }               -- nested properties (merges)
-tName                        -- delete a property
tName.sub.path=value          -- deep path assignment
```

Values can be unquoted identifiers, quoted strings, numbers, or typed values prefixed with `@` (`@true`, `@false`, `@2024-01-15`).

## Givens (Model-Level Parameters)

**Status: experimental, gated by `##! experimental.givens`.** Naming is provisional.

Givens are values supplied at run time that the model can reference in any expression. The motivating use case is row-level access control — a model written once with `where: x.tenant_id = $TENANT` and the tenant supplied per API call — but they also fit configuration values, session context, and any "one compiled model, many invocations with varying context" pattern.

Givens are model-wide: a single namespace, one value per name per compilation. They are *complementary to* source/query parameters (`source: foo(x :: string) is ...`), not a replacement. Use a parameter when you want two differently-bound copies of the same source side-by-side in one model; use a given when you want one value visible everywhere in the compilation.

### Declaration

The `given:` top-level statement introduces givens, with a name, a type, and an optional default:

```malloy
given:
  TENANT :: string
  MAX_ROWS :: number is 1000
  CUTOFF_DATE :: date is @2024-01-01
```

Type can be any Malloy atomic type or compound type, including `filter<T>`:

```malloy
given:
  ROLE :: string
  ALLOWED_ROLES :: string[]
  SESSION :: { user_id :: string, tenant :: string }
  TENANT_FILTER :: filter<string>
```

Defaults are expressions over constants and other givens. Annotations attach to given declarations the same way they attach to sources or measures.

### Reference: the `$` sigil

Inside any expression, a given is referenced with a leading `$`:

```malloy
source: orders_for_user is orders extend {
  where: orders.tenant_id = $TENANT
}

query: recent_orders is orders_for_user -> {
  where: order_date >= $CUTOFF_DATE
  limit: $MAX_ROWS
}
```

`$` appears *only* at expression references. The other three sites where a given's name appears — declaration, import, and supply (caller side) — use the bare name, because syntactic position already disambiguates. Givens share the top-level declaration namespace with sources/queries/views, so `source: x is ...` plus `given: x :: string` is a name-conflict error.

### Set membership: `expr in $arrayGiven`

The RHS of `in` is either a parenthesized list of expressions (`in (1, 2, x, y * 7)`, same as SQL) or a given with an array value (`in $ARR`). A bare array-typed expression — a dimension, a joined array field, an inline `[a, b, c]` literal — is *not* legal on the RHS; arrays only reach the RHS via the given form.

When a given has array type, `expr in $ARR` tests `expr` against the runtime-bound array; `not in $ARR` is the negation. The left-hand side must match the array's element type (`string in $string[]`, `number in $number[]`, etc.); mismatches are translate-time errors. Records and nested arrays are out of scope.

```malloy
given:
  ALLOWED_STATES :: string[]
  URGENT_STATUSES :: string[]

source: orders extend {
  where: state in $ALLOWED_STATES
  dimension: is_urgent is order_status in $URGENT_STATUSES
}
```

At SQL emit, the array's contents land in a generated `IN (...)` clause. Empty or `null` arrays collapse to the obvious result (`IN` → `FALSE`, `NOT IN` → `TRUE`). NULL elements inside a non-empty array follow standard SQL `IN` semantics.

To derive a value from an array — typically a boolean gate — *without* the array itself reaching row-position SQL, use an inline given (below).

### Inline givens

An `inline` given is evaluated at **bind time**, before SQL is emitted: its default expression runs against the resolved given values and reduces to a literal, and that literal is what reaches SQL.

```malloy
given:
  CAPABILITIES :: string[]
  inline CAN_READ_ORDERS :: boolean is 'read_orders' in $CAPABILITIES
  inline CAN_MUTATE :: boolean
    is 'write_orders' in $CAPABILITIES or 'admin' in $CAPABILITIES

source: orders extend {
  where: $CAN_READ_ORDERS   -- SQL sees: WHERE ... AND TRUE  (or FALSE)
}
```

This is the **row-level access-control gate** pattern: the host supplies a capability list as a regular given, an inline given derives a boolean from it, and only the boolean — not the list — crosses into row-position SQL. The query planner sees a constant predicate.

Rules:

- An inline given **must** have a default. `inline FOO :: number` with no `is` clause is a translate-time error.
- The default may use:
  - Boolean and comparison operators: `and`, `or`, `not`, `=`, `!=`, `<`, `<=`, `>`, `>=`
  - The `in $array` test against another given
  - Literals (string, number, boolean, null, array) and references to other givens
- The default cannot call SQL functions, reference fields, or use any operator outside that list. Disallowed operators are reported at translate time with the offending operator names.
- Inline givens are filtered out of `Model.givens` and `PreparedQuery.givens` — they're computed, not supplied — so introspection-driven UIs don't render editors for them. A caller can still shadow one by binding it explicitly (useful in tests).
- `inline` is a context-sensitive modifier, not a reserved keyword: fields, sources, views, dimensions, and joins can still be named `inline`.

### Imports

Givens behave like every other top-level named thing under import:

- **Bare import** (`import "b.malloy"`) brings B's full export surface in, including all of B's givens, under their original names.
- **Selective import** (`import { source1 } from "b.malloy"`) brings in only what's listed. To surface a given to your callers, list it: `import { source1, MAX_ROWS } from "b.malloy"`.
- **Rename** uses the existing `LOCAL is REMOTE` form: `import { CAP is MAX_ROWS } from "b.malloy"`.

Surfacing controls *who can supply a value*, not whether internal references work. An imported source can reference a given the importer didn't surface; the reference still resolves internally, and at run time the unsurfaced given relies on its declaration-site default.

A common project convention is a shared `tenant_givens.malloy` (declaring `$TENANT`, `$USER_ROLE`, etc.) that every root file bare-imports on line 1, so the project's given contract is visible at the top of any model.

### Satisfiability

A query referencing `$X` is satisfiable if either `$X` is in the model's namespace (so a caller can supply a value) or `$X` has a default at its declaration site. Otherwise the query is unsatisfiable and errors. Latent definitions (views, dimensions, measures) that reference `$X` are fine if no query actually invokes them — satisfiability is a property of running queries.

### Supplying values

Values can be supplied at two layers, which compose (per-query overrides per-runtime):

**Per-runtime** — bound to a `Runtime`, applied as defaults to every query through it. Two paths:

1. **`givensPath` in `malloy-config.json`** points at a JSON file of `name → value`:
   ```jsonc
   { "givensPath": "./local-givens.json" }
   // or env-var indirection (resolved at config load):
   { "givensPath": { "env": "GAME_STORE_GIVENS" } }
   ```
   The values file is a flat JSON map, keys are caller-facing surface names:
   ```jsonc
   { "TENANT": "acme", "USER_ROLE": "admin", "CUTOFF_DATE": "2024-01-01" }
   ```

2. **Direct on the Runtime constructor** (for per-request multi-tenant servers, tests, scripts):
   ```typescript
   const runtime = new Runtime({
     config,
     givens: { TENANT: claims.tenant_id, USER_ROLE: claims.role },
     urlReader,
   });
   ```
   Constructor values *merge over* the file at `givensPath` per-key.

**Per-query** — supplied on a single `.run({ givens: ... })` call:
```typescript
await query.run({ givens: { STATE_FILTER: "CA", LIMIT_OVERRIDE: 50 } })
```
Available on every compile-or-run entry point (`runtime.loadQuery(...).run(options)`, `preparedQuery.getPreparedResult(options)`, `preparedQuery.getSQL(options)`).

The resolved per-runtime values are exposed on `runtime.givens` (read-only) for diagnostics.

### Finalized givens (security primitive)

A multi-tenant deployment usually wants `TENANT`/`USER_ROLE`/`REGION` to be runtime-bound and **un-overridable per-query** — otherwise a downstream endpoint that accidentally accepts user-controlled query params and plumbs them into `.run({ givens: ... })` becomes a tenant-leak vulnerability.

`finalizeGivens` in the config locks names at the API surface:

```jsonc
{
  "givensPath": { "env": "GAME_STORE_GIVENS" },
  "finalizeGivens": ["TENANT", "USER_ROLE", "REGION"]
}
```

Finalize doesn't change *what* a given resolves to — only *who* can supply it. A `.run({ givens: { TENANT: ... } })` for a finalized name throws at API entry (named, not silently dropped). Finalized givens are filtered out of `Model.givens` and `PreparedQuery.givens` so introspection-driven UIs don't render editors for locked names.

### JS shapes for supplied values

Both the JSON values file and per-query `givens` maps accept the same per-type shapes:

| Malloy type | JS |
|---|---|
| `string` | string |
| `number` | `number`, `bigint`, or string (precision escape hatch) |
| `boolean` | boolean |
| `date` | ISO date string `"2024-01-15"` |
| `timestamp` (naive) | ISO string without offset — *not* a JS `Date` |
| `timestamptz` | JS `Date` or ISO string with offset (string preferred — makes TZ choice visible) |
| `T[]` | JS array |
| `{ name :: T, ... }` | JS object |
| `filter<T>` | JS string (Malloy filter expression source) |

Naive timestamp givens reject `Date` because `Date` represents a UTC instant, not a wall-clock value, and `new Date("2001-01-01T00:00:00")` silently picks up the system's local TZ. Type mismatches throw at the boundary with a path that points at the offending location (e.g., `givens.SESSION.user_id: expected string, got number`). `null` is legal for any given type.

### Introspection

`Model.givens` and `PreparedQuery.givens` expose, to the host, the supplyable givens — for whole-model parameter editors and per-query "run this" forms respectively. Each entry carries name, type, default expression (or undefined if the caller must supply), location, and access to declaration-site annotations via `tagParse`/`getTaglines`.

## How a Malloy Query Becomes SQL

The compilation pipeline has two phases:

### Phase 1: Translation (source code → IR)

```
Malloy source → ANTLR lexer/parser → parse tree → AST builder → AST → IR generator → IR
```

The **Intermediate Representation (IR)** is a plain, serializable data structure (JSON-compatible) that fully describes the semantic model and query. Note that IR is *not* dialect-agnostic — the same Malloy source compiled against different databases can produce different IR, because schema information, type mappings, and available functions vary by backend. It can be cached, transmitted, and reused. Key IR types:

- **`SourceDef`** — a source's complete definition: schema, fields, joins, filters
- **`Query`** — a source paired with a pipeline of operations
- **`FieldDef`** — definition of any field (dimension, measure, join, calculation)
- **`Expr`** — expression tree (arithmetic, comparisons, aggregates, function calls, field references)

The translator handles all language-level semantics: scoping, name resolution, type checking, evaluation space validation.

### Phase 2: Compilation (IR → SQL)

```
IR → query compiler → expression compiler → dialect-specific SQL generator → SQL + metadata
```

The compiler walks the IR query pipeline, translating each stage into SQL constructs (CTEs, subqueries, GROUP BY, window functions). A **Dialect** layer handles database-specific SQL generation.

The compiler also produces **metadata** alongside the SQL — structural information needed to interpret the result set (column types, nesting structure, annotation data). This metadata is what allows Malloy renderers to reconstruct nested/hierarchical results from the flat SQL result set and apply visualization tags.

### Key architectural consequences

- Because the IR is serializable, it can be cached and reused across compilations (though IR is database-specific — the same source compiled against different backends may produce different IR).
- Because joins are declared in the source (not the query), the compiler knows the full join graph and can compute symmetric aggregates correctly.
- Because nested queries are first-class, the compiler generates the appropriate SQL (correlated subqueries or ARRAY_AGG patterns depending on dialect) automatically.
- Because measures are typed as aggregates in the IR, the compiler can validate that they only appear in aggregate context and enforce locality rules.

## Where to Go Deeper

This document is a conceptual reference — enough to reason about the language and its design, but not exhaustive. Here's where to find more detail.

### Language Documentation

The full docs live at [https://docs.malloydata.dev](https://docs.malloydata.dev). Key pages by topic:

| Topic | URL |
|---|---|
| Sources, extensions, joins, primary keys | [documentation/language/source](https://docs.malloydata.dev/documentation/language/source) |
| Queries, views, reduction vs projection | [documentation/language/query](https://docs.malloydata.dev/documentation/language/query), [views](https://docs.malloydata.dev/documentation/language/views) |
| Fields: dimensions, measures, views, calculations | [documentation/language/fields](https://docs.malloydata.dev/documentation/language/fields) |
| Aggregate functions and aggregate locality | [documentation/language/aggregates](https://docs.malloydata.dev/documentation/language/aggregates) |
| Ungrouped aggregates (`all`, `exclude`) | [documentation/language/ungrouped-aggregates](https://docs.malloydata.dev/documentation/language/ungrouped-aggregates) |
| Nested views / aggregating subqueries | [documentation/language/nesting](https://docs.malloydata.dev/documentation/language/nesting) |
| Joins | [documentation/language/join](https://docs.malloydata.dev/documentation/language/join) |
| Expressions, operators, pick, apply | [documentation/language/expressions](https://docs.malloydata.dev/documentation/language/expressions) |
| Evaluation spaces (literal, constant, input, output) | [documentation/language/eval_space](https://docs.malloydata.dev/documentation/language/eval_space) |
| Filters and filter placement | [documentation/language/filters](https://docs.malloydata.dev/documentation/language/filters) |
| Annotations and tags | [documentation/language/tags](https://docs.malloydata.dev/documentation/language/tags) |
| Calculations and window functions | [documentation/language/calculations_windows](https://docs.malloydata.dev/documentation/language/calculations_windows) |
| Data types | [documentation/language/datatypes](https://docs.malloydata.dev/documentation/language/datatypes) |
| Time operations, ranges, timezones | [documentation/language/timestamp-operations](https://docs.malloydata.dev/documentation/language/timestamp-operations), [time-ranges](https://docs.malloydata.dev/documentation/language/time-ranges), [timezones](https://docs.malloydata.dev/documentation/language/timezones) |
| Imports | [documentation/language/imports](https://docs.malloydata.dev/documentation/language/imports) |
| Top-level statements and model structure | [documentation/language/statement](https://docs.malloydata.dev/documentation/language/statement) |
| Functions reference | [documentation/language/functions](https://docs.malloydata.dev/documentation/language/functions) |

### Examples and Patterns

The docs site includes worked examples of common analytical patterns at [documentation/patterns](https://docs.malloydata.dev/documentation/patterns/): percent-of-total, year-over-year, cohort analysis, sessionization, moving averages, nested subtotals, and more.

End-to-end guides are at [documentation/user_guides](https://docs.malloydata.dev/documentation/user_guides/), including [Malloy by Example](https://docs.malloydata.dev/documentation/user_guides/malloy_by_example) (a comprehensive walkthrough) and a three-part series for SQL users ([part 1](https://docs.malloydata.dev/documentation/user_guides/sql_experts1), [part 2](https://docs.malloydata.dev/documentation/user_guides/sql_experts2), [part 3](https://docs.malloydata.dev/documentation/user_guides/sql_experts3)).

### Source Code

The Malloy implementation lives at [github.com/malloydata/malloy](https://github.com/malloydata/malloy). Key entry points:

| What | Where |
|---|---|
| ANTLR grammar (lexer + parser) | `packages/malloy/src/lang/grammar/` |
| AST node hierarchy | `packages/malloy/src/lang/ast/` |
| Parse tree → AST builder | `packages/malloy/src/lang/malloy-to-ast.ts` |
| IR type definitions | `packages/malloy/src/model/malloy_types.ts` |
| IR → SQL compiler | `packages/malloy/src/model/` |
| Dialect-specific SQL generation | `packages/malloy/src/dialect/` |
| Tag/annotation parsing (MOTLY) | `packages/malloy-tag/` |
| Renderer | `packages/malloy-render/` |
| Architecture overview | `CONTEXT.md` (root and in each package) |
