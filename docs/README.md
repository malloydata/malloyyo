# Malloyyo documentation

**Start here: [the guide](guide/index.md).** It's the user-facing documentation —
what Malloyyo is, how to author and test a semantic model, how to build
dashboards, and how to run a server.

Everything else in this directory is **design and reference material**: the
records of why things are built the way they are. Useful when you're changing
the code, misleading if you read it as instructions.

---

## The guide

| | |
|---|---|
| [Overview](guide/index.md) | What Malloyyo is and how the pieces fit. |
| [Concepts](guide/concepts.md) | The vocabulary — model, source, given, dataset, version, instance. |
| [Authoring a model](guide/authoring.md) | Set up a repo, connect to your data, build the model with an agent. |
| [Testing a model](guide/testing.md) | Rehearse the consumer experience, lint, preview dashboards. |
| [Dashboards](guide/dashboards.md) | `# artifact`, givens and controls, layout, drill, charts. |
| [Publishing](guide/publishing.md) | `malloyyo publish`, versions, the GitHub-pull alternative, CI. |
| [Setting up a server](guide/server-setup.md) | Deploy, configure, admin, sign-in, secrets. |
| [What the server serves](guide/server-surfaces.md) | MCP tools, ltool, dashboards, shared links, question history. |
| [Governance](guide/governance.md) | What an agent can and cannot reach, and how that's enforced. |
| [CLI reference](guide/reference/cli.md) · [`malloy-config.json`](guide/reference/malloy-config.md) · [environment](guide/reference/environment.md) | Look-up material. |

## Operational guides

These are current and user-facing; the guide links to them rather than
duplicating them.

| | |
|---|---|
| [Authentication](authentication.md) | Google, Okta, and Microsoft Entra ID sign-in, end to end. |
| [Self-hosting with Docker](docker.md) | Build and run the container. |

## Design records

Current — these describe how the system works today:

| | |
|---|---|
| [The shared MCP engine](mcp-engine.md) | The three-layer engine design, its principles, and the decisions record. |
| [The explore surface](explore-surface.md) | The consumer flow, and the delivery model for guidance (why `yo_help` carries the methodology and `instructions` carries nothing). |
| [`describe_source` output](describe-source.md) · [describe-shape](describe-shape.md) | The wire contract for describe. |
| [Model publishing](model-publishing-design.md) | The CLI-push design: named targets, the push endpoint, provenance. |
| [Composite dashboards](composite-dashboards.md) | The structure-v2 design — dashboards as files. |
| [Converting a model to dashboard files](migrating-dashboards-to-files.md) | Migration steps from the older in-model declaration style. |
| [Dashboard iframe security](dashboard-iframe-security.md) | The sandbox analysis and what it changed. |

Superseded — kept for the reasoning, not the instructions:

| | |
|---|---|
| [Repo-authored artifacts (v1)](repo-artifacts.md) | The original dashboard design, where dashboards were declared in `index.malloy`. Its sandboxing, compile-at-publish, and "declare data, free-form presentation" arguments still hold; its file layout does not. Current layout: [Dashboards](guide/dashboards.md). |
| [Creating dashboards](creating-dashboards.md) | The earlier dashboard how-to. Superseded by [Dashboards](guide/dashboards.md), which is the maintained version. |

## Release notes

[`updates/`](updates/) — what changed, release by release.

---

## For agents

The guidance an agent reads at runtime is **not** in this directory. It lives in
`packages/mcp-engine/content/`:

- `content/help/**` — the `yo_help` topics (`dashboards/*`, `develop/*`,
  `explore/*`, `language/*`). The directory layout is the topic namespace; add a
  file and it's discoverable.
- `content/prompts/**` — tool titles, descriptions, and per-surface instructions.

Editing those is a code change: rebuild (`npm run build -w packages/cli`) and
restart the MCP server, which loads help at startup.
