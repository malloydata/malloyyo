# Testing malloyyo_client against a local server

The loop this feature is for — an agent fetches a compiled model, iterates
locally, sends the finished query — spans three programs: the Next.js server,
the `malloyyo_client` binary, and Claude driving both. This is how to run all
three from one working tree.

The thing that makes it fiddly is that `fetch_compiled_model` lives on the
**hosted** surface only (`src/lib/mcp-host.ts`), not in the engine's
`exploreSurface`. So `malloyyo mcp` cannot exercise it — you need the real
server at `localhost:3000` and an MCP client pointed at it.

## One-time setup

```bash
npm run build:all     # engine → client → cli → dashboard vendor
npm run dev:link      # put THIS tree's malloyyo + malloyyo_client on your PATH
```

`dev:link` is the load-bearing step. It symlinks the workspace packages
globally, so `malloyyo_client` resolves to `packages/client/dist/index.js` — the
code you are editing, not a published version. Check it:

```bash
which malloyyo_client            # …/bin/malloyyo_client
malloyyo_client --version
```

Re-run `npm run build:all` after every edit; the symlink keeps pointing at the
same `dist/`, so there is nothing to re-link. Undo with `npm run dev:unlink`.

## Run the server

```bash
npx dotenv-cli -e local/staging -- npm run dev      # → http://localhost:3000
```

The dev server knows it is a dev server: `fetch_compiled_model`'s `usage` text
drops the `npm i -g @malloydata/malloyyo-client@<version>` line (which for an
unreleased version would 404) and tells the agent to use the linked build.

## Point Claude at it

From another shell, in any directory:

```bash
claude mcp add --transport http malloyyo-local http://localhost:3000/mcp
claude
```

`/mcp` requires OAuth, so the first connection opens a browser sign-in against
your local server — the same flow production uses, which is worth exercising
anyway. Then just ask for data:

```
> what sources are on malloyyo-local?
> fetch the compiled model and use malloyyo_client to work out the top genres
```

Watch for the agent calling `fetch_compiled_model`, writing the blob to a file,
then shelling out to `malloyyo_client` instead of `query(execute:false)`. That
is the whole feature; if it does not happen, the wording in
`packages/mcp-engine/content/prompts/explore/guidance.md` is the thing to tune.

## Without a server at all

Most client work does not need the server. The CLI produces the identical
envelope from a model directory:

```bash
malloyyo compile -C ~/dev/malloyyo-imdb -o imdb.json
export MALLOYYO_MODEL=imdb.json

malloyyo_client list_sources
malloyyo_client describe_source movies
malloyyo_client query movies 'run: movies -> { group_by: genre; aggregate: c is count() }'
```

## Turning off the version check

A blob records the Malloy that compiled it, and the client refuses a blob from
a different one — reading another compiler's ModelDef is undefined behavior, not
a warning. That gate is right in the wild and occasionally wrong on your laptop:
a half-applied `npm run malloy-update`, or two copies of `@malloydata/malloy` in
one install, will trip it with nothing to "install" to fix it.

```bash
malloyyo_client --any-version --model imdb.json list_sources
# or, for a whole session:
export MALLOYYO_ANY_VERSION=1
```

It downgrades the version and format gates to warnings on **stderr** (stdout
stays parseable JSON, so pipelines still work). It deliberately does **not**
relax the checksum or the encoding check — those catch corruption, which is a
different problem and never something you want to skip.

If you find yourself needing this routinely, that is a signal to fix the
install, not to keep the flag on: `npm ls @malloydata/malloy` will show a second
copy if there is one.

## What to run before pushing

```bash
npm run test:all      # engine + client + cli + server unit suites
npm run weigh -w packages/client   # the install budget (needs network)
bash scripts/preflight.sh          # everything, incl. next build (needs Docker)
```
