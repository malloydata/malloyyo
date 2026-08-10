# Developing and testing malloyyo_client

The loop this feature exists for — an agent fetches a compiled model, iterates
locally, sends the finished query once — spans three programs: the Next.js
server, the `malloyyo_client` binary, and Claude driving both. This is how to
run all three from one working tree, and how to tell whether it is working.

The thing that makes it fiddly: `fetch_compiled_model` lives on the **hosted**
surface only (`src/lib/mcp-host.ts`), not in the engine's `exploreSurface`. So
`malloyyo mcp` cannot exercise it — that one tool needs the real server.

---

## 1. Setup

```bash
npm run build:all     # engine → client → cli → dashboard vendor
npm run dev:link      # put THIS tree's malloyyo + malloyyo_client on your PATH
```

`dev:link` is the load-bearing step: it symlinks the workspace packages
globally so `malloyyo_client` resolves to `packages/client/dist/index.js` — the
code you are editing, not a published version. **Verify it, because a stale
global install here will waste an hour:**

```bash
readlink -f "$(which malloyyo_client)"     # → <your tree>/packages/client/dist/index.js
malloyyo_client --version
```

Re-run `npm run build:all` after every edit; the symlink keeps pointing at the
same `dist/`, so there is nothing to re-link. Undo with `npm run dev:unlink`.

---

## 2. The automated tests

Run these first — they cover most of the surface and need no server:

```bash
npm run test:all                    # engine + client + cli + server unit suites
```

| suite | what it proves |
|---|---|
| `packages/mcp-engine` → `model-blob.test.ts` | the envelope: round trip, compression, version/format/checksum gates, the `allowVersionMismatch` override, and — against a **real compiled model** — that a blob rehydrates and compiles with a connection that throws on every call |
| `packages/client` → `client.test.ts` | the library and the binary: `list_sources`/`describe_source`/`query`, exit codes, `--any-version`, `MALLOYYO_MODEL`, error messages |
| `packages/cli` → `compile.e2e.test.ts` | **the seam**: `malloyyo compile` writes a blob and the `malloyyo_client` binary queries it. Spans two packages, so neither package's own tests can cover it |
| `test/hosted-explore.test.ts` | `fetch_compiled_model` itself — see below |

### The hosted suite (covers `fetch_compiled_model`)

```bash
npm run test:hosted     # needs Docker: ephemeral Postgres + in-process DuckDB
```

It drives `buildHostedExploreSurface().call()` directly — no HTTP, no OAuth —
against a seeded user, dataset and model, and asserts the whole promise in one
test: the tool returns a blob, the blob decodes, and the model behind it
compiles `run: sales -> by_animal` through a connection that rejects every
`runSQL` and schema fetch. Plus: unknown `model_ref` refused without leaking
existence, missing `model_ref` rejected, and the tool advertised on
`tools/list` with the instance tag and host `model` param.

**No Docker?** Any Postgres 16 works. The one catch: the suite seeds fixed rows
(`fox@test.local`) and does not clean up, so it needs an **empty** schema every
run — which is what the Docker script gets for free by recreating the container.
Reset explicitly and it passes repeatedly:

```bash
export DATABASE_URL="postgres://postgres@localhost:55432/postgres"
psql "$DATABASE_URL" -c 'drop schema public cascade; create schema public;'
npx drizzle-kit push --force
npx tsx --test test/hosted-explore.test.ts
```

Skip the reset on a second run and all 16 tests fail on a unique-constraint
violation in `before()` — alarming, and nothing to do with your changes.

---

## 3. Testing the whole loop by hand

The automated tests cover every mechanism. What they cannot cover is whether
Claude actually *chooses* the local path — that is prompt behavior, and the only
way to know is to watch it.

### Without a server

Most client work needs no server at all. The CLI produces the identical
envelope from any model directory:

```bash
malloyyo compile -C ~/dev/malloyyo-imdb -o imdb.json
export MALLOYYO_MODEL=imdb.json

malloyyo_client list_sources
malloyyo_client describe_source movies
malloyyo_client query movies 'run: movies -> { group_by: genre; aggregate: c is count() }'
echo $?        # 0 compiles, 1 does not
```

### With a server, driving Claude

```bash
# shell 1
npx dotenv-cli -e local/staging -- npm run dev          # → http://localhost:3000

# shell 2, any directory
claude mcp add --transport http malloyyo-local http://localhost:3000/mcp
claude
```

`/mcp` requires OAuth, so the first connection opens a browser sign-in against
your local server — the same flow production uses, worth exercising anyway.

The dev server knows it is a dev server: `fetch_compiled_model`'s `usage` text
drops the `npm i -g @malloydata/malloyyo-client@<version>` line (which for an
unreleased version would 404) and points at your linked build instead.

Then ask for something that needs several attempts to get right:

```
> using malloyyo-local, which pairs of genres appear together most often?
```

**What good looks like:** Claude calls `fetch_compiled_model` once, writes the
blob to a file, then shells out to `malloyyo_client query …` — repeatedly, if
the first draft is wrong — and calls the server's `query` tool exactly once at
the end, to get rows.

**What to check afterwards**, rather than trusting the transcript:

```sql
-- did it fetch, and how many server-side compiles did it still do?
select tool_name, executed, count(*)
from history
where created_at > now() - interval '1 hour'
group by 1, 2 order by 3 desc;
```

A healthy run shows one `fetch_compiled_model`, one `query` with
`executed = true`, and few or no `query` rows with `executed = false` — those
are the wire round trips the client is supposed to replace. Lots of
`executed = false` means Claude ignored the local path, and the thing to tune is
the wording in
`packages/mcp-engine/content/prompts/explore/guidance.md` (which rides on every
`list_sources`/`describe_source` result) — not the code.

---

## 4. Turning off the version check

A blob records the Malloy that compiled it, and the client refuses a blob from
a different one — reading another compiler's ModelDef is undefined behavior, not
a warning. That gate is right in the wild and occasionally wrong on your laptop:
a half-applied `npm run malloy-update`, or two copies of `@malloydata/malloy` in
one install, will trip it with nothing to "install" to fix it.

```bash
malloyyo_client --any-version --model imdb.json list_sources
export MALLOYYO_ANY_VERSION=1        # for a whole session
```

It downgrades the version and format gates to warnings on **stderr** — stdout
stays parseable JSON, so `| jq` still works. It deliberately does **not** relax
the checksum or encoding checks: those catch corruption, a different problem
that is never safe to skip.

Needing this routinely is a signal to fix the install rather than keep the flag
on. `npm ls @malloydata/malloy` will show a second copy if there is one.

---

## 5. When it goes wrong

| symptom | cause |
|---|---|
| `Cannot find module '.../src/content/generated'` | the engine's generated content is missing — `npm run build -w packages/mcp-engine` (its `gen` step embeds `content/**`) |
| Client typechecks fail on engine types | the engine's `dist/*.d.ts` is stale; rebuild the engine before typechecking anything downstream |
| `malloyyo_client` runs old code after an edit | you rebuilt one package, not all — `npm run build:all` |
| `which malloyyo_client` points outside your tree | a real npm install is shadowing the link — `npm rm -g @malloydata/malloyyo-client`, then `npm run dev:link` |
| `compiled by Malloy X, but this build bundles Y` | genuine drift, or two copies of malloy; `--any-version` to keep moving, `npm ls @malloydata/malloy` to fix |
| `No connection named "duckdb" found in config` from `malloyyo compile` | connection drivers were not registered — this is `initConnections()`, and its absence is what the message is telling you |
| Claude never calls `fetch_compiled_model` | prompt, not code: see the guidance file above |
| All 16 hosted tests fail in `before()` | you re-ran them against a non-empty database — reset the schema (above) |

---

## 6. Before pushing

```bash
npm run test:all
npm run weigh -w packages/client     # the install budget (needs network)
bash scripts/preflight.sh            # everything, incl. next build (needs Docker)
```

`weigh` is the guard on the only number this package exists for: it packs the
tarball, installs it into a throwaway directory, and fails if the dependency
count exceeds its budget. Currently 51 packages / ~4s / 17MB.
