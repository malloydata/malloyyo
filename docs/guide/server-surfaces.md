# What the server serves

One model version, two audiences. Agents get MCP tools; humans get a web app.
Both write to the same history, so a question asked in a Claude conversation and
a question asked in the browser land in the same accumulating record.

---

## For agents: the MCP endpoint

### Connecting

The endpoint is your instance's origin plus `/mcp` — for example
`https://your-instance.vercel.app/mcp`. It speaks JSON-RPC over HTTP and
requires an OAuth 2.1 bearer token; there is no anonymous access and no API-key
mode.

In claude.ai: **Settings → Connectors → Customize → + → Add custom connector**.
Paste the URL, set the connector name to the instance's `INSTANCE_NAME`, and
authorize. Claude opens a sign-in against your instance, you approve on a
consent page, and the tools appear in every new conversation from then on. It is
a one-time step per instance.

**Set the name to match `INSTANCE_NAME`.** Claude prefixes every tool with the
connector name you type, and the server prefixes every tool *description* with
`[INSTANCE_NAME]`. When those agree, an agent connected to several Malloyyo
instances routes to the right one. When they don't, it guesses.

Nothing needs pre-registering. The server implements OAuth dynamic client
registration (`/api/oauth/register`) and publishes discovery documents, so any
compliant MCP client — claude.ai, the Anthropic Console workbench,
`claude mcp add … --transport http` — can register itself, run the
authorization-code + PKCE flow, and get a token. Only public clients with an
HTTPS (or `http://localhost`) redirect are accepted.

Access is re-checked on **every** call, not just at token issue: a user removed
from the email allow-list loses MCP access immediately rather than when their
token expires.

### The tools

| Tool | What it's for | What comes back |
|---|---|---|
| `list_sources` | Orientation — "what can I ask about?" | Every model visible to you, keyed by model ref, each with the sources it publishes and their descriptions |
| `describe_source` | The map of one source, before writing anything | Its dimensions, measures, and views; the joins it reaches (with fan-out flagged) and the sources those resolve to; a couple of runnable example queries; the source's own Malloy declaration in its own block |
| `query` | Validate or run Malloy against a source | `execute:false` → the generated SQL and the givens the query references. Default → rows, plus a share link |
| `yo_help` | Guidance by topic | The topic body, or the index of topic names when called with no topic |
| `open_share_link` | Resolve a share link someone pasted | The instance, source, question, and Malloy behind the slug — it does **not** run the query |

`describe_source` and `query` take a bare `source` name; `model_ref` is optional
and only needed when the same source name exists in more than one model. Passing
a `model_ref` that names a real model without that source is refused outright
rather than silently resolved through the wrong model — a query must never be
recorded against a model it didn't run on.

### The loop

The methodology is one document, `yo_help("explore/how-to")`, and every tool
result points at it. The loop it prescribes:

1. **Orient** — `list_sources`. Skip it if you already know the source.
2. **Map** — `describe_source`. Read the answer. Don't guess field or join names.
3. **Validate** — `query` with `execute:false`. This compiles without running,
   returns the SQL, and names the givens the query needs. Iterate until clean.
4. **Run** — `query` with a plain-English `question`. Get rows and a link.
5. **Share** — hand the link to the user, or resolve one back with
   `open_share_link`.

**The compiler is the oracle.** Correctness comes from compiling in the loop, not
from `describe_source` being so exhaustive the agent never errs. Describe is a
map; the compiler is ground truth.

Ranking, top-N, and member selection belong in the Malloy, not in the agent's
post-processing. Results are byte-budgeted, so an oversized result is truncated
before the agent ever sees all of it — see [Governance](governance.md).

### What the host adds

The engine that defines these tools is the same code `malloyyo test` runs
locally. The hosted server layers policy on top of it:

- **Instance tagging.** Every tool description is prefixed `[INSTANCE_NAME]`, and
  the server reports that name as its `serverInfo`. This is how an agent with
  three Malloyyo connectors picks the right one.
- **`question` is required.** The engine treats it as optional; the hosted
  `query` tool does not. It is the analytics grouping key, the title on the
  questions page, and the label on the share link. A `query` call without one is
  refused — including a validate-only call.
- **Everything is recorded.** Every tool call writes a history row: successes,
  validate-only compiles, and failures with their error text. Nothing completes
  unrecorded.
- **A successful run returns `ltool_link`.** A `{text, url}` pair, already
  assembled, pointing at `/ltool/<slug>`. Agents are told to present it as a
  markdown link after the data.
- **The SQL of an executed run is withheld from the agent.** It is recorded
  server-side for the audit trail. SQL rides the `execute:false` channel, where
  it is there to be inspected.

### `yo_help` is the guidance channel

MCP's `instructions` string is best-effort — capped, and frequently ignored by
clients. Tool descriptions and tool *results* are the channels a client always
reads. So the guidance lives where it will be read: problems carry a
`help_topic`, and the failing result arrives with the full help body already
attached as `help`. The agent gets the fix where it is already looking, with no
second round trip.

Topics are namespaced by directory, and the name you pass is the path:

| Namespace | Covers |
|---|---|
| `explore/` | The how-to loop, query examples, why a query was restricted |
| `language/` | The Malloy language reference, split per concept |
| `dashboards/` | Authoring artifacts, givens and controls, grid layout, charts |
| `develop/` | Local model development — getting started, connections, models |

`yo_help()` with no topic returns the index of every topic name. That index is
the discovery surface: guidance that isn't reachable through `yo_help` may as
well not exist.

---

## For humans: the web app

### The front page

Datasets, then their sources, then the questions asked against each source. A
dataset shows its public/private badge, a link to the GitHub repo the model came
from, its dashboards, and a per-source menu to explore in Claude or in ltool.

The questions listed under each source are **favorited saved queries** — yours,
plus every admin's. An admin starring a query is how a good starting point
becomes a recommendation for everyone signed in, without a separate curation
tool.

### ltool

`/ltool` is the query surface; `/ltool/<slug>` opens one shared query directly.

The left rail is two axes: **History / Favorites** crossed with **Me / All**. The
right pane holds the question title, the Malloy (collapsed to a one-line preview
until you expand it), the rendered result, and the SQL behind a disclosure.

- **Edit and re-run.** Expand the Malloy, change it, run. An edited query is
  saved as a new entry with its own slug rather than overwriting the one you
  started from.
- **Schema panel.** Expanding the Malloy opens the source's schema alongside it —
  dimensions, measures, views, and joins, so you're not guessing field names.
- **Star.** Your star; the count shows how many others have starred it too.
- **Share.** Copies the `/ltool/<slug>` URL.
- **Rename.** Click the title to retitle a saved query — yours, or anyone's if
  you're an admin.

Because Malloy renders a nested query as a whole dashboard, one saved ltool query
can be a complete report.

### The questions page

`/datasets/<dataset>/questions` is every question answered against that dataset —
asked by Claude over MCP, by other models, by people in ltool — merged from the
disposable history log and the durable saved queries, deduped, newest first.

Each row carries an **author badge** (a model id like `claude-opus-4-8`, the
generic `AI`, or a person's name), the row count, how many times the question was
asked, and how long ago. Clicking one opens its answer in ltool.

This is the accumulated record of what people actually ask. Read as a list, it is
the best available spec for the next version of the model.

### Dashboards

`/datasets/<dataset>/dashboard/<name>` — the dataset reference can be its name or
its id.

How a dashboard renders depends on whether the repo shipped custom code:

- **Tag-only** (no `.jsx`/`.tsx` sibling) — the Malloy renderer runs directly in
  the trusted page. There's no untrusted author code, so there's nothing to
  sandbox.
- **Custom** — the repo-authored component runs inside a sandboxed,
  opaque-origin iframe with no session and no cookie. It talks to the page only
  by `postMessage`. See [Governance](governance.md).

### History, saved queries, favorites

Three different things, and the distinction is what keeps shared links alive.

| | What it is | Lifetime |
|---|---|---|
| **History** | The activity log. Every MCP tool call and every ltool run, including validate-only compiles and failures | Disposable — trimmed |
| **Saved query** | A durable row carrying the question, the Malloy, and its share slug | Kept |
| **Favorite** | A star by one user on a saved query | Kept |

**Saving or starring promotes** a history row into a saved query, carrying its
slug across. That promotion is what makes a link you handed out survive history
trimming. A link you never starred is only as durable as the log it lives in.

### "Explore further with Claude"

Every ltool query with a slug gets this button. It opens a new Claude chat seeded
with an instruction to call `open_share_link` on that slug — so the conversation
starts from the exact source, question, and Malloy behind the result, not from
scratch.

The full round trip:

```
agent answers a question  ──►  mints /ltool/<slug>
        ▲                              │
        │                              ▼
 "explore further"  ◄──  human opens it, edits, re-runs
```

A result stops being the end of a conversation and becomes the start of the next
one. If you haven't connected the instance to Claude yet, the button shows the
one-time setup instructions first.

### Dataset visibility

A dataset is either **public** — visible to everyone signed in — or **private to
its owner**. That predicate governs both surfaces: over MCP you see your own
datasets and public ones, and only those in a `ready` state.

Admins see every dataset except ones whose last publish failed. Ownership and
visibility are set when the dataset is created; admin comes from
`APP_ADMIN_EMAILS`.

---

**Next:** [Governance](governance.md)
