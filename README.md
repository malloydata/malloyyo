# Malloyyo

**Claude builds the dashboards. Malloyyo makes sure the numbers are right.**

Claude is really good at building dashboards. Give it access to your data and it will build you something beautiful in a few minutes. That part is solved.

The missing parts are everything else: semantics, access control, a shared home for the dashboards, and a workflow to manage it all as more and more people build on the same data.

So we built it. Malloyyo serves your dashboards in Claude or on the web. It manages the meaning of your data in a [Malloy](https://malloydata.dev) semantic model. It controls who can see what. And it keeps your dashboards and your model in a GitHub repo, so all of it can be verified and maintained.

Try [the demo server](https://malloyyo.vercel.app/). Sign in with any Google account.

## Data chaos, now 10x

At Looker we called it *data chaos*. Two people walk into a meeting, each with their own analysis. The numbers don't match. An argument starts.

Add AI and the problem gets ten times worse. Analysis is cheap now. Ten people walk into the meeting, each with a vibe-coded dashboard, and none of the numbers match.

There's a second, darker problem: **access control**. The database is the wrong layer for deciding what people can see. A table lands in the wrong place. A permission is missing. Queries draw from lots of places, and it's very hard to know exactly what any one person can reach. The same goes for an AI.

A semantic layer solves both.

- **Numbers match** ✓ The model defines the calculations and the join relationships once, Anything built on those calculations is correct.
- **Access control** ✓ You grant access to a semantic model, which is a much bigger and more meaningful unit than a table. The AI can only query what the model exposes.

## "Do we really need a semantic layer with AI?"

People want a yes-or-no answer. Ours is **"Yes, and…"**

I think the real reason people say "no" is the *end-state* problem. A traditional semantic layer describes calculations and joins, which is great, but a query against it is just a set of parameters. When the calculation you need isn't in the model, you're stuck. You download the data and finish the job somewhere else. A business user opens a spreadsheet. An AI opens Python.

Either way you've left the governed system, and the numbers start to drift.

When we designed Malloy, we decided the semantic layer and the query language had to be **one system**. Malloy describes the semantics, and it's also a complete query language. Any question you can answer in SQL, you can answer in Malloy, scoped to the model. You get consistent definitions and bounded access, and you never hit the end state.

The calculations in the model are guaranteed correct. But you aren't limited to them, the way you are in other systems. You can invent new ones. The interesting ones get factored back into the model.

Claude already knows Malloy, the same way it knows Python. It reads and writes Malloy very well.

## Another reason Looker worked: the workflow

People credit Looker's success to its semantic layer. That was a big part of it. People may have missed something just as important: the **workflow**.

Looker treated data analysts like developers. They wrote semantic models, kept them in version control, reviewed each other's changes, and gave the whole organization accurate data. Business users had autonomy. The data team kept things correct.

Malloyyo brings that workflow to humans and agents working together.

## The loop

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   ▼                                                                  │
 1. BUILD          Claude builds and tests the semantic model in      │
                   your repo, from your SQL, workbooks, or another    │
                   semantic layer.                                    │
   │                                                                  │
   ▼                                                                  │
 2. PUBLISH        Commit, publish to a Malloyyo server, grant        │
                   access by role.                                    │
   │                                                                  │
   ▼                                                                  │
 3. ASK & BUILD    People ask questions and build dashboards, in      │
                   Claude or on the web. When the model is missing    │
                   a calculation, the agent writes it in Malloy.      │
   │                                                                  │
   ▼                                                                  │
 4. REFACTOR       The useful dashboards come back into the repo.     │
                   A data developer and Claude find the calculations  │
                   that matter, promote them into the model, and      │
                   update the dashboards to use them.                 │
   │                                                                  │
   ▼                                                                  │
 5. VERIFY         `malloyyo lint` checks every dashboard against     │
                   the model. Changes land as pull requests.          │
   │                                                                  │
   └──────────────────────────────────────────────────────────────────┘
```

Step 4 is what makes Malloyyo different. Invented calculations are useful, but they haven't been reviewed yet. If nobody looks at them you get drift, with people reading the same data in slightly different ways. In Malloyyo, the dashboards are code in a repo, and Claude can read all of them. It finds the important calculations, puts them back into the shared model, and fixes the dashboards that depended on the old versions. It can also audit what people built and flag real mistakes.

It's the create-and-refactor cycle from software engineering. When it runs regularly, the organization just gets better at working with its data.

## What you get

- **Dashboards in Claude and on the web.** The same dashboards and the same numbers in both places.
- **A semantic model in Malloy.** Measures, dimensions, and joins defined once and correctly.
- **No end state.** Malloy is a full query language, so questions don't have to leave the model.
- **Role-based access control.** Grant datasets to roles. People and AIs see only what the model exposes.
- **Everything in Git.** Models and dashboards live in a repo, published from the CLI or pulled from GitHub on push.
- **Lint across the corpus.** Every change is checked against every dashboard in the repo.
- **Your data where it is.** DuckDB is built in (query Parquet over plain HTTP, no warehouse required), or connect BigQuery, Snowflake, MotherDuck, Databricks, Postgres, and others.
- **Thin by design.** Malloyyo is a small tool. The AI does most of the heavy lifting.

## Getting started

```bash
npm install -g @malloydata/malloyyo
cd my-model-repo
malloyyo init       # sets the repo up for Claude
claude              # "connect to my warehouse and build a Malloy model from these dbt sources"
malloyyo publish    # push it to your Malloyyo server
```

You don't need to know Malloy. Claude writes it, checks it against the compiler, and runs real queries to confirm the numbers.

- [Developing Malloy models](docs/developing-models.md) and the [CLI](packages/cli/README.md)
- [Creating dashboards](docs/creating-dashboards.md)
- [Roles and access](docs/roles-and-access.md)
- [Deploy your own](docs/deploy.md): one click to Vercel, or [self-host with Docker](docs/docker.md)
- [How Malloyyo works](docs/architecture.md): architecture, MCP tools, and a code map

## Say hi

Questions, or built something cool? We'd love to hear from you. Come find us on [Slack](https://join.slack.com/t/malloy-community/shared_invite/zt-2dvtske75-TJQfolRtZGXLS24RhTQ79g), and learn more about Malloy at [malloydata.dev](https://www.malloydata.dev).
