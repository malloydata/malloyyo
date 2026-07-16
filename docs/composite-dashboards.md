# Design: Composite dashboards — one artifact, many tiles

**Status:** Draft, building now. Written 2026-07-15.
**Author:** Lloyd, with Claude.
**Related:** `docs/repo-artifacts.md` (the artifact/dashboard system this
extends), `packages/mcp-engine/src/artifacts.ts` (`# artifact` discovery),
`packages/cli/src/frame-runtime/` (the render runtime + `<Panel>`),
`packages/mcp-engine/src/given-specs.ts` (given/suggest specs),
`docs/migrating-dashboards-to-files.md` (the publishable how-to for authors).

---

## 0. Structure v2 — dashboards are FILES (THE CURRENT PLAN)

> This supersedes the discovery design in §2–3 below (model-level `## artifact`
> in `index.malloy` + source-level `# artifact { tiles }`). The combiner (§4),
> tile grammar (§2.3), givens-union, and render (§3) all carry over unchanged;
> only *where a dashboard is declared and how it's discovered* changes.

**The move:** a dashboard is a **self-contained Malloy file** under
`dashboards/`, compiled **as its own entry** (the way `index.malloy` is for the
MCP surface). It imports the model parts it needs and declares its own
`## artifact`. `index.malloy` goes back to being purely the MCP/ltool surface.

```
model/
  malloy-config.json
  givens.malloy          # given: declarations + control tags (the knobs)
  baby_names.malloy      # source + views + measures + # drill on dims; import "givens.malloy"
  index.malloy           # import/export baby_names  →  MCP/ltool surface only
  dashboards/
    over-represented.malloy     # import source + givens; ## artifact { tiles=[…] }
    name-explorer.malloy        (+ name-explorer.jsx if it has a custom component)
    name-trend.malloy
```

**Why this is right (each verified during design):**

- **`## artifact` just works** — model annotations don't cross imports, so
  `## artifact` was only readable from `index.malloy`. When the dashboard file
  *is* the entry, its own `## artifact` is read directly. (One `##`/file; a
  `##` tag must be one line.)
- **Unlimited cross-source dashboards** — N files = N dashboards. The
  one-`##`-per-file merge-collapse stops mattering.
- **No export-through-index** — the file `import`s exactly what it tiles; nothing
  is re-exported from `index.malloy`.
- **The peer-model given-visibility lint loop DELETES** — it only existed
  because dashboards borrowed `index.malloy`'s scope. A self-contained file
  imports/declares the givens it uses; a missing one is a **loud compile error at
  the tile**, not a silent missing control. (This is also the O(artifacts×peers)
  loop that made `lint` look like it hung — deleted, not just cached.)

### 0.1 Givens — declaration in the model, starting value in the dashboard

"Given" is two things:

- **Declaration** (`given: STATE :: … ` + `# label`/`# control`/`# suggest`
  tags) → lives in the **model**, best in a dedicated `givens.malloy`. Views
  reference them and the MCP surface uses them, so they're a model concern, not
  presentation. (Can't live in `index.malloy` — the source would need to import
  index → cycle.)
- **Per-dashboard starting value** (`## artifact { givens { STATE="CA" } }`) →
  lives in the **dashboard file**.

**Verified visibility rule (spiked 2026-07-15):** a control renders only when
the given's *tagged declaration* is in the dashboard file's scope. Importing the
source alone does NOT bring it (only the query *requirement* rides along). So the
convention is: **every source AND every dashboard does a bare
`import "…/givens.malloy"`** — the whole-file import puts all declarations in
scope; `dashboardGivenSpecs` still surfaces only the givens the tiles actually
reference, so controls = referenced givens automatically, with no enumeration.
(Selective `import { STATE } from …` also works but makes authors list every
given — the bare import is the best practice.)

### 0.2 Drill

`# drill { to=<slug> }` stays on the **root-source dimension** (drill annotates a
data field). It names a dashboard **slug**, which Malloy treats as opaque text —
so a typo is dead navigation, not a compile error. → **new lint check**: every
`# drill` target must resolve to a discovered `dashboards/*.malloy`.

**Requires `@malloydata/malloy` ≥ 0.0.423** — Michael's "Carry field annotations
through a refined nest" (#2982) fixes tags (incl. `# drill`) not propagating onto
refined nests. We bump 0.0.420 → 0.0.423 as part of this work.

### 0.3 Discovery, runner, lint (the code changes)

- **Discovery** — glob `dashboards/*.malloy`; compile **each as its own entry**;
  read its `## artifact`. Replaces the `index.malloy` annotation scan and the
  source-`# artifact { tiles }` scan (both DELETED). Name = file basename,
  overridable by `name=`. Optional sibling `<name>.jsx` is the custom component.
  Cheap now that the config/schema cache stays warm across the per-file compiles.
- **Runner** — `runDashboard`/`dashboardGivens` already take an `entryFile` via
  `leaseIn`; point them at `dashboards/<name>.malloy` instead of `index.malloy`.
  No other change — tiles resolve in the dashboard file's own scope.
- **Lint** — becomes local, loud, and cheap: (1) each `dashboards/*.malloy`
  compiles as its entry; (2) each tile run-expression compiles/runs; (3) each
  referenced given's `# suggest` compiles; (4) `dashboard_columns` is a positive
  int; (5) optional `.jsx` compiles; (6) **NEW** every `# drill` target resolves
  to a dashboard file; (7) **NEW** no orphaned `<name>.jsx` without a
  `<name>.malloy`, no duplicate resolved `name=`. The peer-model loop and the
  `""`-query special case are gone. Keep a standalone "does `index.malloy`
  compile" check for the MCP surface.

### 0.4 Existing single-view `# artifact` dashboards

Decision (2026-07-15): **move them too.** A single-tile dashboard is just
`## artifact { tiles=[one] }` in a `dashboards/*.malloy`. This lets us drop
`index.malloy`/source scanning entirely — one discovery mechanism, one mental
model. The shipped babynames/auto_recalls models get migrated (see the migration
guide) as the reference conversion.

### 0.5 Build order (v2)

1. **Bump malloy 0.0.420 → 0.0.423** (`/malloy-update`) for the drill/nest fix.
2. **Discovery** — glob `dashboards/*.malloy`, compile each as entry, read
   `## artifact`; delete the index/source composite scans.
3. **Runner/givens** — re-point `runDashboard`/`dashboardGivens` at the
   dashboard file entry.
4. **Component** — `dashboards/<name>.jsx` sibling replaces
   `dashboards/<name>/Dashboard.tsx` (keep both during transition).
5. **Publish/gather** — glob dashboards, compile each, bundle definition +
   component.
6. **Lint** — the local checks in §0.3 (incl. the two new ones).
7. **Migrate babynames + auto_recalls**; ship the migration guide.
8. **Docs/guidance** — `yo_help` topic for authoring a dashboard file.

Everything below (§1–9) is the still-valid mechanics (combiner, tile grammar,
render, given union) plus the now-superseded discovery design, kept for context.

---

## 1. What we're adding

Today an **artifact** is one query → one result → one renderer. A `# artifact`
tag on a named query or a source view names a single run-expression
(`<query>` or `<source> -> <view>`), we run it, and hand the one
`API.util.wrapResult(...)` result to a single `MalloyRenderer` viz.

A single `# dashboard` query can lay out *nested views*, but only of **one
source** (the nests all share that source's scope). We want a dashboard whose
tiles come from **different sources and queries**:

- **Model level** (cross-source), a document annotation:
  ```
  ## artifact {
    name="ops" title="Ops overview"
    tiles=[revenue_summary, "orders -> by_month", "users -> signups"]
    dashboard_columns=3
    givens { range="[2024-01-01 to 2025-01-01]" }
  }
  ```
- **Source level** (tiles are that source's own views), on a `source:`:
  ```
  # artifact { title="Orders" tiles=[by_month, by_status, top_skus] }
  ```

The key realization that keeps this simple: the **output shape is identical to a
nested-view `# dashboard` result** — one record whose children render as cards.
Only the *assembly* is new (children run separately, possibly from different
sources), so we reuse the existing renderer wholesale and `dashboard_columns`
rides as the dashboard nest's own `columns` config.

## 2. Decisions (settled)

1. **Discriminator = presence of `tiles=`.** A `# artifact`/`## artifact` tag
   with `tiles` is composite; without it, it's the existing single-query
   artifact (only valid on a query or view). `# artifact { tiles }` on a
   *source* is meaningless today (you can't `run: <source>`), so repurposing it
   is non-breaking.
2. **Two declaration sites.**
   - `## artifact` — model-level document annotation (read from
     `model.annotations`). Has no host identifier, so **`name=` is required**;
     tiles resolve in the **model namespace**.
   - `# artifact { tiles }` on a **source** — `name` defaults to the source
     name; each bare tile is a **view of that source**.

   **Visibility (verified 2026-07-15).** Model annotations are per-file, so a
   `## artifact` is only readable from the served entry when it is written **in
   `index.malloy` itself** — a `## artifact` in a peer file is invisible to the
   entry. Also, the merged tag parser collapses multiple `## artifact` blocks in
   one file (last wins), so v1 supports **one cross-source dashboard, in
   `index.malloy`**. A source-level `# artifact { tiles }` DOES travel with its
   (exported) source through import/export — so per-source dashboards are
   portable and unlimited. Rule of thumb: **cross-source dashboard → one
   `## artifact` in `index.malloy`; per-source dashboards → `# artifact` on each
   source.** (Multiple cross-source dashboards later would need per-line parsing
   via `@malloydata/malloy-tag`, a dep the engine avoids; the escape hatch is a
   source that wraps the others.) A `##` annotation is **one line** — the whole
   `## artifact { … }` tag must stay on a single line (a wrapped `{` becomes
   stray Malloy and fails to compile).
3. **Tile grammar (arrow form).** A tile is a run-expression. Bare when it's a
   single identifier (a top-level query, or — at the source site — a view of
   that source); a quoted string for a `"source -> view"` path. The tag grammar
   *requires* this: `parseAnnotation` rejects both bare `orders.by_status` ("Expected
   an identifier") **and** bare `orders -> by_status`; only a quoted string or a
   lone identifier parses. Arrow (not dot) so it matches `run:` and
   `ArtifactInfo.query` everywhere else.
4. **`dashboard_columns` — optional pass-through.** When set, it becomes the
   dashboard nest's `columns`; when unset, we emit nothing and the renderer
   uses its default. No columns knob of our own.
   (`@malloydata/render` `DashboardNestConfig` already carries
   `columns`/`gap`/`maxTableHeight` and per-child `colspan`/`subtitle`/`break`.)
5. **Givens = union, rerun-all.** The controls are the **union** of givens
   referenced across all tiles (each declared once at model scope). Any control
   change **re-runs every tile**, re-synthesizes the one combined result, and
   updates the single renderer in place. No partial-rerun routing. Each tile
   runs with the current values of *the givens it references* (we already have
   that set from computing the union), so an unused filter never reaches a tile
   that would reject it.
6. **`suggest { query = … }` takes the same arrow form.** `query=daily_totals`
   (bare, today's form) or `query="orders -> by_status"` (quoted path). Since
   `run: <value>` already accepts a `source -> view` path, this is almost free.
7. **No MCP surface for now.** Composite artifacts are host-render only
   (dashboard dev server + hosted app). Not runnable as data over MCP yet.

## 3. Two authoring surfaces (the A/B question, resolved)

These are not a fork — they are the two authoring modes the system already has,
sharing one primitive (`<Panel>`):

- **A — no `Dashboard.tsx` (the simple path).** We read `tiles` from the
  artifact metadata, run + combine on the server into one `# dashboard`-shaped
  result, and render it with **one** `<Panel result={combined}/>`. Zero JS.
- **B — a hand-written `Dashboard.tsx` (the escape hatch).** The author places
  `<Panel query="orders -> by_month" .../>` per tile wherever they want. This
  already works today — `Panel` already takes a `query` and fans out its own run
  through the bridge (`runtime.tsx` `Panel`/`useQuery`). The `tiles` list is
  just the declarative shorthand for what B writes by hand.

The one new runtime affordance that lets A and B share the primitive: **`Panel`
accepts a pre-run `result`**, not only a `query`/`malloy` to fetch (it already
switches on `query` vs `malloy`; this is a third input mode). A's default
dashboard hands each Panel a result; B's Panels fetch. An author can mix.

## 4. The combined result (VERIFIED — a tile *is* a nest)

The composite runner merges N wrapped tile results into **one** result the
renderer treats as a `# dashboard`. Spiked against real babynames results
(2026-07-15): in the interfaces format a `nest:` and a standalone tile result
are **structurally identical**, so the merge is a pure, verbatim transform — no
reshaping, no re-compile.

A `nest:` in a result is:
- schema field — `{ kind:"dimension", name, type:{ kind:"array_type",
  element_type:{ kind:"record_type", fields:[…DimensionInfo] } }, annotations }`
  (i.e. **array<record>**);
- cell — `{ kind:"array_cell", array_value:[ { kind:"record_cell",
  record_value:[…] }, … ] }`.

A standalone tile's `data` is that *same* `array_cell`, and its `schema.fields`
are that same DimensionInfo shape. So:

```ts
tileAsNest(tile, name) = {
  kind: "dimension", name,
  type: { kind: "array_type", element_type: { kind: "record_type",
    fields: tile.schema.fields.map(f => ({ name: f.name, type: f.type, annotations: f.annotations })) } },
  annotations: liftRenderTags(tile.annotations),   // # line_chart / # shape_map / # colspan …
};
combined = {
  connection_name: tiles[0].connection_name,
  model_annotations: tiles[0].model_annotations,   // ##! experimental flags
  annotations: [{ value: `# dashboard {columns=${n}}\n` }],
  schema: { fields: tiles.map(t => tileAsNest(t.res, t.name)) },
  data: { kind: "array_cell", array_value: [
    { kind: "record_cell", record_value: tiles.map(t => t.res.data) } ] },
};
```

`liftRenderTags` carries a tile's result-level render annotations (`# line_chart`
etc., excluding the internal `#(malloy) …` and keeping/omitting `#"` docs as the
card subtitle) onto its nest field so the card renders as the tile intended.
`dashboard_columns` becomes the root `# dashboard { columns=n }` (omitted when
unset → renderer default).

Per-tile failure is isolated: a failed tile's problems ride on the returned
result and the rest still render — matching the engine's "helpers never throw;
failures ride as `problems[]`" rule. **Browser render VALIDATED 2026-07-15**: a
cross-source `## artifact` (tiles from two different sources) rendered as a
two-column dashboard through Malloy's own renderer via the dev server.

## 5. Data shapes

```ts
// artifacts.ts — ArtifactInfo gains:
interface ArtifactInfo {
  // …existing: name, query, source?, view?, title, description?, givens?, autorun?
  /** Composite: the tile run-expressions (a query name or `source -> view`),
      in declaration order. Present iff this is a composite artifact. */
  tiles?: string[];
  /** Optional pass-through to the dashboard nest's `columns`. */
  dashboard_columns?: number;
}
```

A composite `ArtifactInfo` has `tiles` set and `query` empty/absent (there is no
single run-expression). `readArtifactTag` branches: `tiles` present → composite
(parse `tiles` + `dashboard_columns`, require `name` at the model site); else →
today's single-query path.

The engine's combined result is an ordinary `RunResult` whose `stable_result` is
the merged `# dashboard` result — so it flows through the existing
`RunResult` → `Panel` → renderer path unchanged. No new envelope type on the
wire; the novelty is entirely in *how* `stable_result` is built.

## 6. Where the code changes (reuse map)

- **`artifacts.ts`** — `readArtifactTag` parses `tiles`/`dashboard_columns`;
  `artifactQueries` gains two passes: (1) `model.annotations` for `## artifact`
  (new — today it only scans queries + views), (2) each source's own
  `# artifact { tiles }` (new — today only a source's *views* are scanned).
- **tile resolver** (new, small) — tile string → run-expression, contextual:
  model site passes it through (`run: <tile>`), source site prefixes bare view
  names with `<source> -> `.
- **given union** — call the existing `dashboardGivenSpecs` per tile, merge by
  name; carry per-tile referenced-given sets for the rerun-all pass.
- **composite runner** (new) — loop tiles → `run: <expr>` (reusing
  `executeMaterialized`) → **combiner** (Section 4) → one `RunResult`.
- **`host.ts` / `ModelRunner`** — a `runDashboard(artifact, givens)` that does
  the above; the single-query `run` stays as is.
- **frame runtime** — `Panel` accepts `result`; `DefaultDashboard` branches:
  composite → one `<Panel result={combined}/>`; single → today.
- **`given-specs.ts`** — `suggest.query` already becomes `run: <value>`; confirm
  a quoted `source -> view` value flows through (it does — it's a string).
- **`lint.ts`** — per tile: compiles/runs; `dashboard_columns` positive int;
  model-level artifact requires `name`; existing not-re-exported-given warning
  runs per tile.

## 7. Lint / validation

**STATUS: deferred.** Lint currently **skips** composite artifacts (a guard in
`lint.ts` short-circuits them) — the single-artifact checks assume one `query`,
which a composite doesn't have, and the composite structure is still in flux.
When it settles, implement the per-composite checks below.

For each composite artifact:
- every tile resolves and `run: <expr>` compiles (bad tile → clear error naming
  the tile);
- `dashboard_columns`, if present, is a positive integer;
- a `## artifact` (model site) carries `name`;
- duplicate artifact `name`s across sites are rejected;
- the per-tile "given not re-exported by index.malloy" warning (today's
  single-artifact check) runs for each tile.

## 8. Build order (de-risk first)

1. ~~**Spike the combiner**~~ — DONE 2026-07-15. Verified a tile *is* a nest
   (Section 4); the merge is a verbatim transform. Real-render validation
   deferred to integration (dev server).
2. **Combiner module** (`mcp-engine`) — `combineTiles(results, {columns})` →
   one `# dashboard` result. Pure, unit-testable against golden fixtures.
3. **Tag + discovery** — `ArtifactInfo.tiles`/`dashboard_columns`,
   `readArtifactTag`, `artifactQueries` model (`## artifact`) + source passes.
4. ~~**Composite runner + given union**~~ — DONE. `runDashboard` /
   `dashboardGivens` in `host.ts`.
5. ~~**`Panel` accepts `result`** + **`DefaultDashboard` composite branch**~~ —
   DONE; browser-render validated.
6. **`suggest` arrow form** (tiny) + **lint** (validate each tile; composites
   have no single `query`).
7. **Docs/guidance** — extend the authoring guide; a `yo_help` topic later.

## 9. Open questions / later

- **Per-tile presentation** (`colspan`, `subtitle`, `break`, `borderless`) — the
  renderer supports them per child; source them from each tile query's own
  annotations later, not inline in `tiles`.
- **MCP** — a combined result over MCP (deferred here) would need a projection
  that strips `stable_result` and summarizes tile rows.
- **Nested composites** — a tile that is itself a `# dashboard` query renders
  fine (it's just a nested-view result); a tile that is another *composite*
  artifact is out of scope.
