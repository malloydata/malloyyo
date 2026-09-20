---
description: Writing a draft dashboard from a chat client — one component file, queries inline, saved with save_draft_dashboard; and how one is promoted into the model repo
---

# Draft dashboards (`save_draft_dashboard`)

A draft is a dashboard stored on this instance rather than in the model repo.
It gets a URL, renders like any other dashboard, and can be re-saved as often
as you like. Read this before writing one.

## The shape

ONE React component, default-exported, whose queries are Malloy written inline:

```tsx
import { useQuery } from "@malloyyo/dashboard";

export default function Dashboard() {
  const top = useQuery({
    malloy: `run: flights -> { group_by: carrier; aggregate: flight_count; limit: 10 }`,
  });
  const rows = top.rows ?? [];
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Top carriers</h1>
      {top.loading ? <p>Loading…</p> : <ol>{rows.map((r) => (
        <li key={String(r.carrier)}>{String(r.carrier)}: {Number(r.flight_count).toLocaleString()}</li>
      ))}</ol>}
    </div>
  );
}
```

Save it with `save_draft_dashboard({ dataset, name, title, source })`. The
result carries a `url` to open and a `dashboard` name that `show_dashboard`
renders. Pass the returned `slug` back on the next save to update the same
draft instead of making another.

## The queries

Inline Malloy runs against what the model PUBLISHES — the same rules as the
`query` tool. You may define your own sources, measures and joins derived from
the model's sources. You may not `import`, open a connection, write raw SQL, or
declare `given:`. Check a query with `query(execute:false)` before you put it
in a component; the save also compiles every literal query it finds and reports
what failed.

Write the whole query as one template literal. A query built by string
concatenation can't be checked at save time and only fails when a reader opens
the dashboard.

## What you can import

Only these resolve:

| Import | What you get |
|---|---|
| `react` | React itself, hooks included |
| `@malloyyo/dashboard` | `useQuery`, `useGiven`, `useOptions`, `useUrlState`, `runData`, `filters`, `VegaChart`, `Field`, and the controls: `Controls`, `Given`, `Select`, `Search`, `MultiSelect`, `Range`, `Checkbox`, `TimeRange` |

Nothing else — no chart library, no icon set, no CSS framework, no `fetch`.
Use inline `style` objects, plain HTML, and `VegaChart` (see
`yo_help dashboards/vega-charts`) for charts.

`useQuery` returns `{ rows, result, loading, error }`. `rows` is an array of
plain objects. Numbers can arrive as BigInt or decimal objects, so wrap them
with `Number()` before `.toLocaleString()` or arithmetic, and format dates in
Malloy rather than in JavaScript.

## Presentation

- One clear page title, then the content. No wrapper card around everything.
- Put a few headline numbers in a row, value large (~40px) with a small label
  beneath; don't stack them vertically.
- Give each query-backed section its own loading and error state, so a slow one
  doesn't blank the page.
- Prefer a table under ~8 categories, where exact values and ranking matter;
  use a chart when shape or trend is the point.
- Keep charts responsive in width and roughly 200–280px tall.
- Say what the data shows. Don't call a change strong, concerning or surprising.

## When to add a `.malloy` file instead

Pass `malloy` as well when the dashboard needs:

- **filters/controls** — declare givens in the model and the controls render
  themselves (`yo_help dashboards/givens-and-controls`);
- **named queries** shared across several tiles, or a composite grid
  (`yo_help dashboards/authoring`);
- **no code at all** — a tagged Malloy query renders through Malloy's own
  renderer, which is often the better dashboard.

That file is `dashboards/<name>.malloy`: it imports `"../index.malloy"` and
tags a query `# artifact`.

## Promotion

A draft lives on the instance; the model repo is where dashboards belong. To
move one in, from a checkout of the repo:

```bash
malloyyo draft list                  # find the slug
malloyyo draft promote <slug>        # writes dashboards/<name>.malloy + component
```

Promotion writes the files and records what the draft became; it never deletes
the draft, whose URL people may already hold. A draft whose queries are inline
needs them LIFTED into its `.malloy` as named queries — the component then uses
`useQuery({ query: "<name>" })` — because a repo dashboard's queries live in
the model, not the component. The written `.malloy` carries them as comments to
work from. Then `malloyyo lint`, and the usual PR.

## Iterating

1. `list_sources`, then `describe_source` for the source you'll query.
2. Validate each query with `query(execute:false)`.
3. Save the draft; fix anything the report names.
4. Show the user the URL (or `show_dashboard`), and ask what to change.
5. Re-save with the same `slug`.
