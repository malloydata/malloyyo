# Malloyyo

**An 'agentic-native' workflow for data.**

You describe your data once, in a semantic model. An agent helps you write it,
tests it against the real thing, and publishes it. From then on, every
agent — and every human — asks questions through that model instead of writing
SQL from scratch.

*Agentic-native* means rethinking the workflow to put agents where they're most
helpful — and removing the interfaces that are no longer necessary once they're
there. Dashboards are the clearest case: in Malloyyo a dashboard is **code**, and
there is no visual designer. You don't need one. You ask an agent to make the
change, and you work alongside it in a test environment until the result is
exactly what you wanted.

**Agentic-native** and **conversational** are the two drivers of Malloyyo's
design. Everything below follows from them.

---

## The problem

Point an AI at a raw database and it writes SQL from scratch, every time. The
same question next week produces a different query and a different number.
Wrong joins, invented columns, fan-out double-counts — and the answer still
*looks* right, which is the part that hurts.

// AI + SQL is not deterministic.  When agents have to write complex equations from 
//  documentation, they make mistakes.  A semantic layer encodes the calculations deterministicly.

The fix isn't a better prompt. It's giving the AI something to compose against.

## The shape

Malloyyo is a **semantic model** — measures, dimensions, joins, defined once and
correctly — plus the workflow around it. Two halves, one loop:

- **The `malloyyo` CLI** is where the model gets made. An agent authors it,
  compiles it, queries real data through it, and rehearses the questions your
  users will actually ask. You steer from results, not syntax.
- **The Malloyyo server** is where it gets used. The same model becomes
  governed MCP tools for agents and a query surface, dashboards, and shared
  links for humans.

Between them sits **`malloyyo publish`** — compile-gated and versioned. Nothing
reaches the server that doesn't compile.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  AUTHOR                        cd my-model && claude          │
   │                                                               │
   │   your agent  ──edit──►  *.malloy  ──compile──►  problems[]   │
   │       ▲                     │                        │        │
   │       └─────────────────────┴──query real data───────┘        │
   │                                                               │
   │   malloyyo test        rehearse what the web will see         │
   │   malloyyo lint        check the dashboards                   │
   └───────────────────────────────┬──────────────────────────────┘
                                   │
                          malloyyo publish        (compile-gated, versioned)
                                   │
   ┌───────────────────────────────▼──────────────────────────────┐
   │  SERVE                            your Malloyyo instance      │
   │                                                               │
   │   /mcp  ──── governed tools ────►  claude.ai, any MCP client  │
   │   web   ──── ltool, dashboards, shared links ────►  humans    │
   │                                                               │
   │   every question answered is recorded, shareable, and         │
   │   hands back to an agent to keep exploring                    │
   └───────────────────────────────┬──────────────────────────────┘
                                   │
                    what people actually ask ──► back to the model
```

That last arrow is the point. The questions your model can't answer are the
best possible spec for the next version of it.

## Authoring is a conversation

You do not have to know Malloy. Install the CLI, set up a repo, and start
Claude Code in it:

```bash
npm install -g @malloydata/malloyyo
cd my-model-repo
malloyyo init          # writes .mcp.json, scaffolds index.malloy
claude                 # opens in author mode
```

```
> connect to my Postgres warehouse and build a model from these dbt sources
> add a "net revenue" measure and check it against last quarter's numbers
```

`malloyyo init` wires the repo so `claude` starts connected to the **author
surface** — tools that compile, prettify, and run queries against the files on
disk. The agent works compiler-in-the-loop: write, compile, read `problems[]`,
fix, run a real query, look at the numbers. You read results and redirect.

Claude already knows Malloy the way it knows Python, so this goes fast.

→ **[Authoring a model](authoring.md)**

## Testing is a dress rehearsal

A model that compiles is not a model that answers questions. Before you
publish, run the model through the surface your consumers will actually get:

```bash
malloyyo test          # Claude, wired ONLY to the explore surface
```

This is the same code the hosted `/mcp` endpoint runs, restricted the same way,
seeing only what your model exports. Ask it the questions your users will ask.
When it flounders, that's a model bug — a missing measure, an unclear name, a
join that isn't there. Fix it now, not after someone else hits it.

→ **[Testing a model](testing.md)**

## Dashboards are queries

A dashboard is a `.malloy` file. You write a query, tag it, and that's the
dashboard — the filters, the layout, the title, and the drill targets all come
out of the model:

```malloy
// dashboards/overview.malloy
#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
query: overview is order_items -> {
  where: brand ~ $BRAND, created_at ~ $PERIOD
  aggregate: total_sales, total_gross_margin, order_count
  nest: sales_trend, top_brands
}
```

Most dashboards contain no JavaScript at all. Preview them locally with
`malloyyo dashboard dev`; they ship with the model when you publish.

→ **[Dashboards](dashboards.md)**

## The server serves two audiences

**Agents** connect over MCP. The tools are deliberately few — list the sources,
describe one, run a query — and deliberately fenced: a query can only compose
over what your model publishes. No imports, no raw SQL, no reaching past the
model into the warehouse.

**Humans** get the web app: browse datasets and sources, run and edit queries in
ltool, star and share them, open a dashboard. Every shared link is a real URL
someone can hand to a colleague — or hand back to Claude with *"Explore further"*
to pick up where the query left off.

Both audiences write to the same history, so each dataset accumulates a visible
record of what people actually asked and what came back.

→ **[What the server serves](server-surfaces.md)** · **[Governance](governance.md)**

## Running your own

One instance serves many datasets and many users. Deploy it to Vercel with a
button, or self-host the container.

→ **[Setting up a server](server-setup.md)** · **[Publishing](publishing.md)**

---

## The guides

| | |
|---|---|
| **[Concepts](concepts.md)** | The vocabulary — model, source, given, dataset, version, instance. Start here if a word below is unfamiliar. |
| **[Authoring a model](authoring.md)** | Set up a repo, connect to your data, build the model with an agent. |
| **[Testing a model](testing.md)** | Rehearse the consumer experience, lint, preview dashboards. |
| **[Dashboards](dashboards.md)** | `# artifact`, givens and controls, layout, drill, charts. |
| **[Publishing](publishing.md)** | `malloyyo publish`, versions and provenance, the GitHub-repo alternative, CI. |
| **[Setting up a server](server-setup.md)** | Deploy, configure, admin, sign-in, secrets. |
| **[What the server serves](server-surfaces.md)** | MCP tools, ltool, dashboards, shared links, question history. |
| **[Governance](governance.md)** | What an agent can and cannot reach, and how that's enforced. |

**Reference:** [CLI commands](reference/cli.md) ·
[`malloy-config.json`](reference/malloy-config.md) ·
[environment variables](reference/environment.md)

---

Malloy itself is documented at [malloydata.dev](https://www.malloydata.dev) and
[docs.malloydata.dev](https://docs.malloydata.dev). Questions, or built
something good? Come say hi on
[Slack](https://join.slack.com/t/malloy-community/shared_invite/zt-2dvtske75-TJQfolRtZGXLS24RhTQ79g).
