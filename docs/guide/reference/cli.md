# CLI reference

Every `malloyyo` command, what it does, and what it touches on disk.

---

## Install

The package is `@malloydata/malloyyo`; the command it installs is `malloyyo`.
Node ≥ 20.

```bash
npm i -g @malloydata/malloyyo
malloyyo --help
```

Or run it without installing:

```bash
npx @malloydata/malloyyo --help
```

`malloyyo --version` prints the installed package version — the same string the
local MCP server reports as its `serverInfo.version`.

## Commands

| Command | What it does |
|---|---|
| [`init [dir]`](#init) | Write `.mcp.json` so `cd repo && claude` opens in author mode; scaffold `index.malloy` if missing. |
| [`author [-C dir]`](#author-and-test) | Launch Claude wired to **only** the author surface. |
| [`test [-C dir]`](#author-and-test) | Launch Claude wired to **only** the explore surface — the web preview. |
| [`mcp [-C dir] [--develop\|--explore]`](#mcp) | Run the local stdio MCP server over the model in a directory. |
| [`dashboard dev [-C dir] [-p port]`](#dashboard-dev) | Serve `dashboards/` locally with live reload. |
| [`lint [dir]`](#lint) | Validate `index.malloy` and every dashboard against the model. |
| [`login [target]`](#login-and-logout) | Browser sign-in to an instance; stores a refreshable token. |
| [`logout [target]`](#login-and-logout) | Forget the stored token for an instance. |
| [`publish <target> [dir]`](#publish) | Lint, gather, and push the model to a target. |
| [`status <target>`](#status) | Report what's live on a target: version, commit, compile state. |

Commands that talk to a server (`login`, `logout`, `publish`, `status`) resolve
their target from a config file — see
[`malloy-config.json`](malloy-config.md#the-malloyyo-targets-block). Commands
that read the model (`mcp`, `dashboard`, `lint`, `publish`) resolve connections
from the same file.

---

## `init`

```bash
malloyyo init          # the current directory
malloyyo init ./model  # somewhere else
```

Sets up a model repo so that starting Claude Code in it lands in author mode.
`dir` defaults to `.`; a path that isn't an existing directory is an error.

**Writes `.mcp.json`:**

```json
{
  "mcpServers": {
    "malloyyo_author": { "command": "malloyyo", "args": ["mcp", "--develop"] }
  }
}
```

The server key is `malloyyo_author`, so the mode shows up in every tool name
(`mcp__malloyyo_author__compile`) and can't be confused with a similarly-named
server. There is deliberately **no `-C` flag**: the server roots at the
directory Claude was launched from, so the file carries no absolute paths and is
portable and committable.

Because `.mcp.json` is *additive*, your other MCP servers stay connected.

**An existing `.mcp.json` is never clobbered.** `init` leaves it alone and
prints the entry a fresh one would contain, so you can merge it by hand.

**Scaffolds `index.malloy`, only when it doesn't already exist.** The scaffold is
a regex scan — not a compile — over the sibling `*.malloy` files in `dir` (not
subdirectories), looking for top-level names:

| Pattern matched | What it finds |
|---|---|
| `source: NAME is …` | sources |
| `query: NAME is …` | top-level queries |
| `NAME :: …` | givens (the `::` type annotation) |

Line comments are stripped first, so a commented-out `// query: foo` doesn't
match. For each file with hits, `init` emits an `import { … } from './file'`
and a matching `export { … }`. A file with no detectable names gets a comment
telling you to add its exports by hand.

This is a *starting point to review*, not a result to trust — the heuristic
doesn't know which names belong on your public surface. Validate it with
`malloyyo lint`, `malloyyo mcp --develop`, or `malloyyo dashboard dev`.

If `dir` contains no `.malloy` files at all, the scaffold is skipped.

## `author` and `test`

```bash
malloyyo author            # author surface, over the current directory
malloyyo test              # explore surface, over the current directory
malloyyo test -C ./model   # over a different project root
```

Both write an ephemeral single-server MCP config to a temp directory and exec:

```
claude --strict-mcp-config --mcp-config <that file>
```

with the child's working directory set to the resolved root. The temp directory
is removed when Claude exits.

| | `author` | `test` |
|---|---|---|
| server key | `malloyyo_author` | `malloyyo_test` |
| server command | `malloyyo mcp --develop -C <root>` | `malloyyo mcp --explore -C <root>` |
| surface | develop — compile / prettify / query any `.malloy` | explore — `index.malloy` only, as published |

The ephemeral config pins an **absolute `-C`**, unlike the one `init` writes.

**`--strict-mcp-config` drops your other MCP servers for that session.** For
`test` that is the entire point: on claude.ai your model is the only tool in the
room, and an agent that can only answer by reaching for a filesystem or a web
search has told you something about your model. For day-to-day authoring you
usually want your other servers, so prefer `malloyyo init` plus `cd repo &&
claude` — that `.mcp.json` is additive.

If `claude` isn't on your PATH, the command prints a diagnostic and returns
rather than failing silently.

→ [Authoring a model](../authoring.md) · [Testing a model](../testing.md)

## `mcp`

```bash
malloyyo mcp                      # explore surface (default), cwd as root
malloyyo mcp --develop            # author surface
malloyyo mcp --explore -C ./model # explicit, different root
```

Runs a local **stdio** MCP server over the Malloy model in the project root.
This is what `init`, `author`, and `test` all launch under the hood; run it
directly to wire the surface into any MCP client.

| Option | Default | Meaning |
|---|---|---|
| `-C, --root <dir>` | current directory | Project root. All agent-supplied paths are resolved under it and rejected if they escape it. |
| `--develop` | off | Author surface: compile, compile_file, prettify, and query any `.malloy` path in the project. No `index.malloy` required. |
| `--explore` | **on** | Explore surface: the same engine code the hosted `/mcp` endpoint runs, over `index.malloy` only. |

`--develop` and `--explore` are mutually exclusive; passing both is an error.
Passing neither gives you explore.

**The mode is encoded in the server name** the client sees in `serverInfo` —
`malloyyo-develop` or `malloyyo-explore` — and in the config keys `init`,
`author`, and `test` use (`malloyyo_author`, `malloyyo_test`), which is what
lands in the `mcp__<key>__` tool prefix. Between them the mode is an
announcement nothing can truncate. A short mode stub is appended to the server
instructions; the substantial guidance lives in `yo_help` topics instead,
because instruction blocks get clipped by clients.

Other behavior worth knowing:

- **Connections are registered at startup** by importing the full connection
  package, so every supported backend is available.
- **Config is re-read when it changes.** Each call stats `malloy-config.json`
  and `malloy-config-local.json`; a changed mtime or size re-runs discovery. You
  can edit connection config mid-session without restarting the server.
- **Config errors are surfaced as problems**, from both channels — a throw out
  of discovery and the config's own log — rather than being swallowed into a
  misleading `field-not-found` cascade.
- **Connections are idled after every call**, which releases file locks (so a
  co-running process can share the same DuckDB file) while keeping schema caches
  warm.
- **In explore mode, only `index.malloy` is reachable.** Any other model
  reference is refused, and if the file doesn't exist the catalog is empty.
- **The MCP protocol owns stdout.** Nothing else is written there.
- `INSTANCE_NAME`, if set in the environment, is used in the rendered
  instructions; otherwise it's `Malloyyo`.

## `dashboard dev`

```bash
malloyyo dashboard dev
malloyyo dashboard dev -C ./model -p 5000
```

Serves the dashboards in `./dashboards` against the local model, with live
reload. `dev` is currently the only action; anything else is an error.

| Option | Default | Meaning |
|---|---|---|
| `-C, --root <dir>` | current directory | Project root — must contain `index.malloy`. |
| `-p, --port <port>` | `4173` | Port for the trusted shell. **`port + 1` is also bound**, for the artifact origin. |

It refuses to start if there is no `index.malloy` at the root, or if no
`dashboards/*.malloy` file carries an `# artifact` tag.

**Two origins, on purpose.** The trusted shell is served on `port`; the
untrusted artifact document and its bundle are served on `port + 1`. Only the
shell origin exposes `/api/run` — the one privileged capability, calling the
model runner. A custom dashboard's iframe gets `allow-same-origin` (so Malloy's
renderer can load its workers and wasm) while staying cross-origin to the shell,
so it can reach the runner only by `postMessage`, never directly.

| Route | Origin | Serves |
|---|---|---|
| `/` | shell | The dashboard page (in-page or iframe host) |
| `/inpage.js` | shell | The in-page bundle for tag-only dashboards |
| `/api/run` | shell | The model runner (POST) |
| `/events` | shell | Live-reload SSE stream |
| `/frame` | artifact | The sandboxed artifact document |
| `/bundle.js` | artifact | The custom component, bundled with the frame runtime |

**Tag-only vs. custom.** A dashboard with no sibling `dashboards/<name>.jsx` or
`.tsx` mounts the runtime's default dashboard **directly in the trusted page** —
no iframe, full width, page scrolling. There's no untrusted author code to
contain. A dashboard *with* a component runs in a
`sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`
iframe on the artifact origin. The startup banner labels each one.

**What `/api/run` will run** is the same governance contract the explore MCP
surface enforces: a named query the model publishes, or restricted Malloy text
(no `import`, no `given:` declarations, no `connection.*`, no raw SQL, no `##!`
flags). A v2 dashboard runs everything against its **own** file, since its query
and imports live there rather than in `index.malloy`.

**Live reload.** A recursive watch on the project root fires on any `.malloy`
change or any path containing `dashboards`, debounced 150 ms. It re-discovers
the tagged queries, then pushes a reload over SSE. Given specs are re-introspected
from the model on every page load, so an edit to a `given:` declaration — its
type, default, or tags — shows up on reload. Component bundles are cached by the
mtimes of the component and every frame-runtime source file. If the platform
can't watch recursively, the server says so and keeps running without auto-reload.

**URL state.** `?d=<name>` selects the dashboard; every other query parameter is
a given value. The shell rewrites the URL as controls change, so a filtered view
is a link you can paste.

This is a dev server: one local user, no auth, no viewer scoping. It runs the
same engine `run()` the hosted server does, so filter and given behavior is
faithful — but it is not the production serving path.

→ [Dashboards](../dashboards.md)

## `lint`

```bash
malloyyo lint
malloyyo lint ./model
```

Validates the model surface and every dashboard. `dir` defaults to `.`. If
there's nothing to lint it prints `no dashboards to lint` and exits 0.

Checks, in order:

| Check | Fails when |
|---|---|
| Entry model | `index.malloy` exists but doesn't compile on its own. It's the MCP and ltool surface, so it's validated independently of any dashboard. |
| Orphaned component | A `dashboards/<name>.jsx` or `.tsx` has no matching `<name>.malloy`. |
| Dashboard compile | A `dashboards/*.malloy` fails to compile **as its own entry** — a bad import, an undefined tile source, or an unresolved given, reported at its line. |
| Duplicate names | Two dashboards resolve to the same name. |
| `dashboard_columns` | Present but not a positive integer. |
| Empty artifact | The `# artifact` tag declares neither a query nor tiles. |
| Tile compile | A tile's run-expression doesn't compile in that dashboard file's scope. |
| Suggest shape | A referenced given's `# suggest {…}` is neither `suggest { source=… dimension=… }` nor `suggest { query=… }`. |
| Suggest compile | The suggestion query doesn't compile **exactly as the runtime builds it** — the check that saves you, because a broken suggestion otherwise only surfaces when a user clicks the control. |
| Component transpile | A `<name>.jsx`/`.tsx` doesn't parse (esbuild, automatic JSX). |
| Component query literals | A hard-coded `query="…"` string literal in a component no longer resolves. `query={expr}` is dynamic and skipped. |
| Drill targets | A `# drill { to=… }` on a source dimension names no discovered dashboard. Drill targets are opaque tag text Malloy never validates, so a typo is otherwise silent dead navigation. |

A `dashboards/*.malloy` with **no** `# artifact` tag is treated as a shared
include and skipped, not flagged.

**Warnings never fail the lint** — they print with a `warning:` prefix and are
advisory. Errors print under a `✗` and exit the process with code **1**.

`publish` runs this first, so a clean lint is a preview of whether your publish
will go through.

## `login` and `logout`

```bash
malloyyo login main                          # a named target from the config
malloyyo login https://malloyyo.example.com  # a raw URL — no config needed
malloyyo login                               # omit it when unambiguous
malloyyo logout main
```

**Login is per instance, not per dataset.** It authenticates you to a *URL*, for
every dataset on it — which is why the argument is a target name or a URL, and
never a dataset name.

Target resolution reads the config in the **current directory** (not the
directory you're publishing) and accepts:

| Argument | Resolves to |
|---|---|
| Something starting `http://` or `https://` | That URL, directly. No config needed. |
| A named target | That target's `url`. |
| Omitted, one target defined | Its `url`. |
| Omitted, several targets sharing one `url` | That `url`. |
| Omitted, several distinct URLs | An error listing the target names. |

**The flow** is OAuth 2.0 Authorization Code with PKCE and a loopback redirect:
the CLI discovers the instance's endpoints, starts a listener on a random free
port at `127.0.0.1`, dynamically registers itself as a public client
(`token_endpoint_auth_method: "none"`, scope `mcp`) with that redirect URI, opens
your browser, and exchanges the returned code for a token pair. It prints the
authorization URL too, so you can paste it if the browser doesn't open. Sign-in
times out after 5 minutes.

**The token is stored** in `~/.config/malloyyo/credentials.json` (or
`$XDG_CONFIG_HOME/malloyyo/credentials.json`), written mode `0600` and chmod'd
back to `0600` if the file already existed. It is **keyed by instance URL**, so
you can be signed in to several instances at once. Access tokens refresh
themselves when they're within 60 seconds of expiry; if the refresh fails you're
told to log in again.

`logout` deletes that instance's entry and reports whether there was one.

## `publish`

```bash
malloyyo publish main              # push the model in . to the "main" target
malloyyo publish staging ./model
malloyyo publish main --dry-run
```

| Option | Meaning |
|---|---|
| `--token <token>` | Bearer token; takes precedence over the config env var and your login session. |
| `--dry-run` | Gather, lint, and print what would be sent — then stop. Nothing is POSTed. |
| `--skip-lint` | Skip the pre-publish dashboard lint. |

`target` is required and must name an entry in the config block. `dir` defaults
to `.`, and **the config is read from `dir`** — so `malloyyo publish main
./model` uses `./model/malloy-config.json`.

What happens, in order:

1. **Resolve the target and the bearer token** (see
   [Token precedence](#token-precedence)).
2. **Gather** every `*.malloy` file under `dir`, recursively, skipping
   `node_modules`, `.git`, and anything whose name starts with `.`. Paths are
   made relative and POSIX-separated so imports resolve the same way on the
   server. `malloy-config.json` **at the root only** is included. No `.malloy`
   files at all is an error.
3. **Lint the dashboards** unless `--skip-lint`. A failure aborts the publish and
   tells you to fix it or pass `--skip-lint`.
4. **Gather the dashboards.** Each `dashboards/*.malloy` is compiled as its own
   entry to read its `# artifact` tag; that tag becomes the stored manifest
   (title, entry file, tiles or query, columns, description, givens, autorun).
   The optional flat component `<name>.jsx`/`.tsx` rides along as its source. A
   file with no `# artifact` is skipped as a shared include.
5. **Record git provenance** — origin repo as `owner/name`, branch, full sha, and
   whether the tree was dirty. Outside a git checkout this is empty and the
   summary prints `(no git)`.
6. **POST** to `<url>/api/datasets/<dataset>/model/push` with a bearer token.

```
→ https://malloyyo.example.com  dataset=ecommerce
  7 file(s)  main@a1b2c3d
✓ published version 12 — 4 source(s), 3 dashboard(s)
```

**A server-side compile failure makes `publish` exit non-zero**, which is what
makes it safe to gate CI on. The live model is untouched.

→ [Publishing](../publishing.md)

## `status`

```bash
malloyyo status main
```

| Option | Meaning |
|---|---|
| `--token <token>` | Bearer token; same precedence as `publish`. |

Reads `<url>/api/datasets/<dataset>/model/status` and prints the live version,
the commit it came from, and whether it compiled:

```
main: https://malloyyo.example.com  dataset=ecommerce
  version 12  main@a1b2c3d
  ✓ compiled 2026-07-22T14:02:11Z
```

Unlike `publish`, `status` takes no directory argument — it always resolves the
target from the config in the **current** directory.

---

## Token precedence

`publish` and `status` resolve their bearer token the same way, first match
wins:

| Order | Source | Use it for |
|---|---|---|
| 1 | The `--token <token>` flag | One-offs and scripts. |
| 2 | The env var named by `malloyyo_token: { "env": "…" }` on the target | CI. Only the variable *name* is committed. |
| 3 | Your stored `malloyyo login` session for that instance URL | Interactive work. Auto-refreshed. |

With none of the three, the command tells you to run `malloyyo login <target>`.

```yaml
- run: npx @malloydata/malloyyo publish main
  env:
    malloyyo_main_token: ${{ secrets.MALLOYYO_TOKEN }}
```

---

**Related:** [`malloy-config.json`](malloy-config.md) ·
[environment variables](environment.md) · [Concepts](../concepts.md) ·
[Governance](../governance.md) · [project README](../../../README.md)
