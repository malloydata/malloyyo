// Authoring directions surfaced to an MCP client (Claude Code) via the local
// `malloyyo mcp` server instructions. Tells the agent how to build a dashboard
// artifact for the model it's exploring.
//
// Prototype note: this is appended host-side to the explore surface's rendered
// instructions. The eventual home is the engine content pipeline
// (content/prompts/**), but shipping it here keeps the loop testable now.

export const DASHBOARD_GUIDANCE = `

# Authoring dashboards

A dashboard is DECLARED IN THE MODEL — there is no manifest file and, for the
basic case, no JavaScript at all. Preview with \`malloyyo dashboard dev\`; check
with \`malloyyo lint\`.

## The model is the whole contract

**1. Tag a top-level query** with \`# artifact\` to declare a dashboard:

\`\`\`malloy
#" Births per year for the name, split male / female
# artifact title="Name trend"
query: name_trend is baby_names -> births_by_gender + { where: name ~ $NAME }
\`\`\`

That's a complete dashboard: the runtime auto-renders a title (the tag's
\`title\`, else the \`#"\` doc comment), a control for every given the query
references, and the result panel. \`name="slug"\` overrides the URL/directory
slug (default: the query name). (The tag is \`# artifact\`, not \`# dashboard\`
— that's a renderer tag and would change how the result draws.)

Two dashboards can share a given but start on different values — a \`givens\`
block in the tag sets PER-DASHBOARD defaults (given values, i.e. filter
expressions; URL params still win):

\`\`\`malloy
# artifact { name="manufacturer" title="Manufacturer Recall Profile" givens { MANUFACTURER="Ford Motor Company" } }
\`\`\`

This replaces the "declare the given's default per dashboard" role the old
manifests had: declare the given once with a neutral default (often \`f''\` =
no filter), and let each tag pick its landing state.

**2. Declare the filters as \`filter<T>\` givens** — never raw strings/numbers.
A \`filter<string>\` value accepts one value ('NY'), alternatives ('NY, CA'),
wildcards ('Ann%'), negation ('-NY'); a \`filter<number>\` accepts ranges
('[1910 to 1930]') and comparisons ('> 200'). Apply with \`~\`:

\`\`\`malloy
##! experimental { givens }
given:
  # label="State" control=select suggest { source=baby_names dimension=state }
  STATE :: filter<string> is f'NY'
  # label="Manufacturer" suggest { query=manufacturer_options dimension=Manufacturer }
  MANUFACTURER :: filter<string> is f''
  # label="Years" range_min=1910 range_max=2025
  YEAR_RANGE :: filter<number> is f'[1910 to 1930]'
  # label="Include rare names"
  INCLUDE_RARE :: boolean is false
\`\`\`

(A \`boolean\` given renders as a checkbox — bind it in a custom component
with \`<Checkbox given="INCLUDE_RARE" />\`.)

Tags on the declaration drive the control (tag syntax is \`key="value"\` —
equals, not colon):
- \`label\` — control caption (defaults to the given's name)
- \`suggest { … }\` — where the control's options come from. NO Malloy code in
  strings — just names:
  - \`suggest { source=baby_names dimension=state }\` — the DISTINCT VALUES of
    a dimension on a source
  - \`suggest { query=manufacturer_options dimension=Manufacturer }\` — the
    FIRST COLUMN of a named query (declare the query in the model — governed
    and reviewable)
  A \`dimension\` (in either form) is what enables SERVER-SIDE TYPEAHEAD: the
  runtime refines the base query with what the user has typed
  (\`… + { where: lower(field) ~ f'll%'; limit: 50 }\`, case-insensitive,
  escaped). Without a dimension the fetched list is filtered client-side.
  Runs as a restricted query; lint checks the declaration compiles.
- \`control=select\` — a fixed dropdown instead of a typeahead search box
- \`range_min\` / \`range_max\` — bounds; makes a filter<number> given a
  dual-thumb range slider
- anything else passes through in \`spec.tags\` for custom components

## Custom components (optional): ./dashboards/<slug>/Dashboard.tsx

When the default UI isn't enough, add ONE file. It composes the runtime's
widgets/hooks with your own React — you own layout, copy, and theming; the
model still owns every query and filter:

\`\`\`tsx
import React from "react";
import { Controls, Given, Search, Select, Panel, filters, useGiven } from "@malloyyo/dashboard";

export default function Dashboard({ dashboard, givens }) {
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      <h1>{dashboard.title}</h1>
      <Controls>
        <Given name="STATE" />          {/* picks the control from the declaration */}
        <Search given="NAME" />         {/* committing input + typeahead + validation */}
        <Select given="MIN_SAMPLE"
          options={[10, 200, 1000].map(n => ({ value: filters.greaterThan(n), text: \`> \${n}\` }))} />
      </Controls>
      <Panel givens={givens} />         {/* the tagged query, Malloy renderer */}
      <Panel malloy="baby_names -> births_by_decade" givens={givens} />  {/* restricted text */}
    </div>
  );
}
\`\`\`

From \`@malloyyo/dashboard\` (also handed to the component as props):
- **Widgets** (headless-ish; restyle via className/style or CSS vars
  \`--dash-fg/-muted/-border/-accent/-control-bg/-controls-bg\`):
  \`<Controls/>\` (all givens, or compose children), \`<Given name/>\`,
  \`<Select given [options]/>\`, \`<Search given/>\`, \`<Range given [min max]/>\`,
  \`<Checkbox given/>\` (bound to a boolean given)
- **Hooks**: \`useGiven(name)\` → {value, set, spec};
  \`useOptions(name, typed?)\` → {options, loading} (typeahead);
  \`useQuery({query|malloy, givens})\` → {rows, loading, error} — plain rows
  for your own visuals
- **Helpers**: \`filters.oneOf/contains/between/atLeast/…\` build
  filter-expression strings with correct escaping; \`filters.values/
  numberRange/threshold\` read them back; \`filters.isValid\` checks typed input.
  Never hand-concatenate a filter string.
  **Escaping rule for custom controls:** a filter given's value is an
  EXPRESSION, so committing a raw column value is wrong the moment it contains
  a comma/percent/dash ('Tesla, Inc.' parses as two alternatives and matches
  nothing). Commit \`filters.oneOf(value)\` (exact) or
  \`filters.contains(term)\` (substring), and unwrap for display with
  \`filters.values(src)\`. The stock \`<Select/>\` does this automatically;
  \`<Search/>\` deliberately commits raw text (its input IS a filter
  expression). \`''\` = no filter (matches everything) — the natural "All"
  option; no \`$X = '' or …\` dance in the model, just \`col ~ $X\`.
- \`<Panel/>\` and \`runData(text, givens)\` — named queries are the primary
  form; arbitrary Malloy runs as a RESTRICTED query (no import / given: /
  connection.* / raw SQL / ##! flags — the model's published surface only).

## Rules
- Declare data in the model: givens are \`filter<T>\`, options come from
  \`# suggest {…}\` declarations, dashboards are \`# artifact\` tags. If a query or given you
  need is missing, add it to the \`.malloy\` file first (check with
  \`describe_source\`).
- Only React + \`@malloyyo/dashboard\` are importable. No other imports, no
  network — the runtime sandboxes the component.
- Interactivity = setting given values (filter-expression strings), not
  rewriting query text per interaction.

## Preview
\`malloyyo dashboard dev\` → open the printed URL. Edits to \`.malloy\` (tags,
givens, queries) and \`Dashboard.tsx\` hot-reload. \`malloyyo lint\` validates
the tagged queries, given \`suggest\` declarations, and any Dashboard.tsx.
`;
