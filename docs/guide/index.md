# Malloyyo

**A Semantic data model and an agentic-native workflow.**

Semantic data models improve the accuracy of working with AI and data.  Semantic data models encode 
aggregate and scalar calculatations, join relationships, filtering and other nuances in producing 
accurate results.

Semantic data models are used to emit SQL to query data.  

When an AI writes SQL, it must first 
ingest all the rules around the data. The AI needs to know

  * the schema for the tables
  * which columns to join on
  * what data to exclude when writing queries
  * How to calculation simple and commplex things
  * How to map as set complex things to simple ones (15 kinds of statuses to 3 kinds)

Every time an AI writes ones of these queries, it has to reload all this context.

**but wait! AIs + SQL are so cool!**

AIs have gotten quite proficient in writing SQL.  If you work in data, I'm sure you've tried it 
and been amazed.  AIs can write complex, correct SQL simply by asking.  The problem is not the AI, 
the problem is SQL itself.  

A SQL query in isolation is just fine.  Two SQL queries that are 'mostly' the same is the problem.
When and AI or a human distills a context to SQL there are suble differences.  "What timezone are we 
in?".  "Are you accounting for returns when you compute revenue?".   These are all things that are
encoded into the semantic data model.  

There is is a ton of good research about why you should use a semantic data model if you are serious 
data.

[1]: Rumiantsau & Fokeev, ["Semantic Layers for Reliable LLM-Powered Data
    Analytics: A Paired Benchmark of Accuracy and Hallucination Across Three
    Frontier Models"](https://arxiv.org/abs/2604.25149), arXiv:2604.25149 (2026)
    — adding a semantic document to the schema improved accuracy by +17 to +23
    percentage points across three frontier models.

[2: Choi, ["Fact-Consistency Evaluation of Text-to-SQL Generation for Business
    Intelligence Using Exaone 3.5"](https://arxiv.org/abs/2505.00060),
    arXiv:2505.00060 (2025) — on real enterprise BI data, accuracy fell from 93%
    on simple aggregations to 4% on arithmetic reasoning without explicit
    business semantics.

[3]: Lee, Kim & Hwang, ["Bootstrapping Semantic Layer from Execution for
    Text-to-SQL"](https://arxiv.org/abs/2606.05634), arXiv:2606.05634 (2026) —
    supplying the missing semantic layer consistently improves text-to-SQL over
    strong baselines.

[3]: Gartner, ["Lack of Semantics Causes Inaccurate AI Agents and Wasted
    Spending"](https://www.gartner.com/en/newsroom/press-releases/2026-05-11-gartner-says-lack-of-semantics-causes-inaccurate-artificial-intelligence-agents-and-wasted-spending)
    (May 2026) — projects that prioritizing semantics in AI-ready data will
    increase GenAI accuracy by up to 80% and reduce costs up to 60% by 2027.

**At the core of Malloyyo is Malloy**

The Malloy language (the language behind Malloyyo), is more ambitious than other semantic data models.
In the Malloy language, you not only write the calculations and joins, but you also write the 
common queires that are useful with the dataset.  Malloy has a very rich query language that let's
you express complex things quite simply.  But don't worry, the language can be used bythe AI, its not something
you need to deeply understand. 

**How Malloyyo works**

The goal of Malloyyo's development experience is designed to replacate that experience 
fantastic agentic experience you might of had asking an AI to write a SQL query for you.

The, "I just asked and it built this crazy thing for me". Is what we are going for.  But
instead of having the AI write SQL, we're having it write something thiat is more 'deterministic' 
(you get the same thing, everytime you ask the same question) and something that is
maintainable.

The goal is that you an use AI to help build can Malloy 'context' simply by asking AI
and pointing it at some source materials.  AIs know Malloy in the same way they know
Python.  They can build a Malloy model, simply by asking.  

Once the model is built, many people can ask questions of the data and get reliable and consistent 
answers.

I like to say that Malloyyo is   *Agentic-native*  - The creation interface is conversational 
instead of usual drag and drop of traditional BI.  Everything from the semantic model to building 
dashboards to doing analysis is converstational. No need to draw and wire dashboards.  No need
built notebooks.  Conversations do yield artifacts like Dashboards and Notebooks, but the the builder
is your voice. AI are your 'hands'

Let's see how it works.  

First, install malloyyo

```
npm install -g @malloydata/malloyyo
```

Next initialize malloy and ask it to build a semantic model.

```
$ malloyyo init
$ claude
──────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Go into bigquery examin the dataset, retai and build me a semantic model around retail transactions.
  YOu can look in folder ../code for the SQL Alchemy ORM for reference.  I'm going to paste a document
  that contains some SQL queries wthat we currently use.  Can you make sure that the model can
  run these queries?  Verify that we're getting the same results
────────────────────────────────────────────────────────────────────────────────────────────────────────── 

```

The AI will crunches away for a while, maybe asks you some questions.


Now we have our semantic model. In a separate shell  run `malloyyo test`.  This will launch claude.  
You test the robustness of the model by asking questions.

```
$ malloyyo test  
──────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Has there been any recent changes in purchasing patterns from our customers?  
────────────────────────────────────────────────────────────────────────────────────────────────────────── 
```

As you test, you might find things you want to change.  Ask once claude to make the change and the other 
to try and use it.

When you are happy with your model, you can publish it on a Malloyyo server so any AI surface that supports 
MCP can use it.  

```
$ malloyyo publish http://...
```



is the idea behind that: put agents where they're most helpful,
and drop the interfaces that stop being necessary once they're there. Dashboards
are the clearest case — a Malloyyo dashboard is **code**, so you ask an agent to
change it and work alongside it in a test environment until it's exactly what you
wanted. There is no visual designer, because you no longer need one.
**Agentic-native** and **conversational** are the two drivers of the design;
everything below follows from them.

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

At the center is a **semantic model** — your data, described once. Around it are
two interfaces: one for **creating** the model, one for **using** it.

**Creating** happens in the `malloyyo` CLI. The model is code in a git repo: you
edit files, compile them, query real data, and test before you ship. This is
what coding agents are already good at, and it's where an agent is most
powerful — at the command line, in a repo. You don't have to know much Malloy;
you describe what you want and steer from the results. The handful of commands
you type yourself are setup and the checkpoints — test, publish — not the
modeling.

Because it's code, you're also not locked into the agent. Open the folder in VS
Code with the
[Malloy extension](https://marketplace.visualstudio.com/items?itemName=malloydata.malloy-vscode)
and write and run queries by hand whenever you'd rather see it yourself.

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

## Creating is a conversation

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

---

