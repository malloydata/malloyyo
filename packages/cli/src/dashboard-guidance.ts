// Authoring directions surfaced to an MCP client (Claude Code) via the local
// `malloyyo mcp` server instructions. Tells the agent how to build a dashboard
// artifact in ./dashboards for the model it's exploring.
//
// Prototype note: this is appended host-side to the explore surface's rendered
// instructions. The eventual home is the engine content pipeline
// (content/prompts/**), but shipping it here keeps the loop testable now.

export const DASHBOARD_GUIDANCE = `

# Authoring dashboards

You can build a **dashboard** for this model: a small React view that renders one
or more of the model's queries, with filter controls. Store it in the repo under
\`./dashboards/<name>/\`. Preview it with \`malloyyo dashboard dev\`.

## Before you write anything
1. Call \`describe_source\` to see the model's **named queries** and its
   **givens** (the declared filter inputs, e.g. STATE, DECADE, with their types).
   A dashboard may ONLY run named queries the model exposes, driven by givens —
   never invent Malloy in the dashboard.
2. If the query or givens you need don't exist yet, add them to the \`.malloy\`
   model first (a top-level \`query:\` that references \`$GIVEN\` in its filters),
   then re-check with \`describe_source\`.

## Files to create
\`./dashboards/<name>/manifest.json\`
\`\`\`json
{
  "title": "Human title",
  "query": "<a named query from the model>",
  "givens": [
    { "name": "STATE",  "label": "State",  "type": "string", "control": "select",
      "options": ["CA","NY","TX"], "default": "CA" },
    { "name": "DECADE", "label": "Decade", "type": "number", "control": "select",
      "options": [1980,1990], "default": 1980 }
  ]
}
\`\`\`
Given \`name\`s must match the model's given names exactly; \`type\` must match.

\`./dashboards/<name>/Dashboard.tsx\` — a default-exported React component. It
receives everything as props from the host runtime; it must NOT import data
libraries, fetch, or hold credentials:
\`\`\`tsx
export default function Dashboard({ manifest, givens, setGiven, Panel }) {
  // givens   : current filter values, e.g. { STATE: "CA", DECADE: 1980 }
  // setGiven : (name, value) => void  — change a filter, the Panel re-runs
  // Panel    : <Panel givens={givens} /> runs manifest.query with those givens
  //            and renders the result with Malloy's renderer
  // Lay out the controls + Panel however you like — this is your React.
}
\`\`\`

## Rules
- Only React is available to the dashboard (plus the injected \`Panel\`). No other
  imports, no network, no arbitrary Malloy — the runtime sandboxes it.
- Interactivity is done by changing **givens** (which drive the query's filters),
  not by rewriting queries.
- The dashboard runs against the SAME model you're exploring, so what you preview
  is what the model actually returns.

## Preview
From the model repo: \`malloyyo dashboard dev\` → open the printed URL. Editing
\`Dashboard.tsx\` and reloading rebuilds it.
`;
