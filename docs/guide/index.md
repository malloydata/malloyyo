# Malloyyo

**An agentic-native workflow for data.**

You describe your data once, in a semantic model. An agent helps you write it,
tests it against real data, and publishes it — and from then on every agent, and
every human, asks questions through that model instead of writing SQL from
scratch.

*Agentic-native* is the idea behind that: put agents where they're most helpful,
and drop the interfaces that stop being necessary once they're there. Dashboards
are the clearest case — a Malloyyo dashboard is **code**, so you ask an agent to
change it and work alongside it in a test environment until it's exactly what you
wanted. There is no visual designer, because you no longer need one.
Agentic-native and **conversational** are the two drivers of the design; everything
below follows from them.

---

## The problem

**AI plus SQL is not deterministic.** Point an agent at a raw database and it
writes the query from scratch, every time — reconstructing your business logic
from documentation and inference as it goes. Ask the same question next week and
you get a different query and a different number.

The reconstruction is where it breaks. Anything with a real calculation behind
it — net revenue, margin, active user, churn — is a formula the agent is
re-deriving from prose. Wrong joins, invented columns, fan-out double-counts. And
the answer still *looks* right, which is the part that hurts.

**The fix isn't a better prompt.** A semantic layer encodes those calculations
once, deterministically, so the agent composes against them instead of
re-deriving them.

## How it works

Malloyyo provides two surfaces, one for one for **creating** it, one for
**using** it.

**Creating** happens in the `malloyyo` CLI. The model is code in a git repo: you
edit files, compile them, query real data, and test before you ship.  This is what coding agents are
already good at. You really don't have to know much.  The only command you will end up typing
yourself is the one to set it up.  An agent is most powerful at the commandline.  

And conversely, because it's code, you're not locked into the agent. Open the folder in VS Code
with the
[Malloy extension](https://marketplace.visualstudio.com/items?itemName=malloydata.malloy-vscode)
and run queries by hand when you'd rather see it yourself.

**Using** is the end product, and it's where the value actually lands. Agents
reach the published model over MCP as a small set of governed tools. Humans reach
it through the web app — a query surface, dashboards, and links they can hand to
a colleague. Both ask their questions *through* the model; neither writes SQL
against the warehouse.

Between the two sits **`malloyyo publish`** — compile-gated and versioned.
Nothing reaches the people using it that doesn't compile.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  CREATE                        cd my-model && claude          │
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
   │  USE                              your Malloyyo instance      │
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
surface** — tools that claude build semantic models and dashboards

```
> Build me a dashboard that let's me see an indvidual user's purchase history.
> Let me see their returns.  Make it filterable by time.
```

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

A dashboard is a `.malloy` file inside the semantic model.  This is an important design point.  
Dashboards are compiled with the model.  They don't rot.


The dashboard can be made from one or more
malloy queries.  A dashboad can use Malloy's simple renderer or can be built in 
javascript and react.  Either way, Claude can write it for you.

For Malloy's dashboard renderer, you write a query, tag it, and that's the
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

Dashboard are tested locally.  Simply run `malloyyo dashboard dev`.


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
