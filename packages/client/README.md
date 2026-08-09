# malloyyo_client

Compile and debug Malloy queries **offline**, against a model published to a
Malloyyo instance. No database, no credentials, no network.

```bash
npm i -g @malloydata/malloyyo-client
```

## Why

Querying a Malloyyo instance over MCP means a round trip per attempt, and a
first draft rarely compiles: a measure is spelled wrong, a field lives on a
join, a view takes a parameter. Each of those costs a network call to discover.

A published model is **already compiled** — every source's schema is baked into
it — so the compiler needs nothing but the model to answer "is this query
valid, and what SQL does it make?" This package does exactly that, locally, and
nothing else:

| | packages | install | on disk |
|---|---|---|---|
| `@malloydata/malloyyo` (the full CLI) | 661 | ~47s | 530 MB |
| `@malloydata/malloyyo-client` | **51** | **~4s** | **17 MB** |

The CLI carries BigQuery, Snowflake, DuckDB, the renderer and Vega because it
publishes models and runs them. A client that only compiles needs the Malloy
compiler and nothing more.

Compiling a query against a real model takes **~450ms** including Node startup,
and ~30ms per query within one process.

## Getting a model

Two producers, one format.

**From an instance** — call the `fetch_compiled_model` MCP tool with a
`model_ref` from `list_sources`, and save the result:

```
fetch_compiled_model(model_ref: "imdb")   →   save the JSON to imdb.json
```

**From a model repo you have locally** — the full CLI compiles it:

```bash
malloyyo compile -C ./my-model -o model.json
```

## Using it

The subcommands *are* the MCP tools — same names, same arguments, same JSON —
because they dispatch into the same engine code the server runs. What you learn
here transfers verbatim to the hosted tools.

```bash
malloyyo_client --model imdb.json list_sources
malloyyo_client --model imdb.json describe_source movies
malloyyo_client --model imdb.json query movies 'run: movies -> { group_by: genre; aggregate: c is count() }'
```

`--model` can also come from `MALLOYYO_MODEL`, so it can be set once:

```bash
export MALLOYYO_MODEL=imdb.json
malloyyo_client describe_source movies
```

Exit status is the whole signal, so it composes:

| code | meaning |
|---|---|
| `0` | the query compiles (result carries the generated `sql`) |
| `1` | it does not (result carries `problems`, with line/column and a help topic) |
| `2` | usage error, or the model file could not be read |

```bash
malloyyo_client query movies "$Q" >/dev/null && echo "safe to send"
```

## Queries are compile-only

This client never runs anything — it holds a model, not data. Once a query
compiles, send it to the instance's `query` MCP tool to get rows. That is the
intended loop: **iterate locally, execute remotely, once.**

## Versions

A compiled model is the Malloy compiler's internal shape, so a blob can only be
read by the Malloy version that wrote it. Every blob records that version and
the client release that matches it, and the client refuses a mismatch by name:

```
this model was compiled by Malloy 0.0.420, but this build bundles Malloy 0.0.425.
A compiled model can only be read by the Malloy that wrote it.
Install the matching client:  npm i -g @malloydata/malloyyo-client@0.2.29
```

`malloyyo_client --model <file> info` prints both versions and the model's size.

The client, the `malloyyo` CLI and the server release together at one version,
so the version a server stamps onto a blob always names a client that exists.

## Development

```bash
npm run build      # bundle (mcp-engine is bundled in; malloy stays external)
npm test           # unit + binary tests
npm run weigh      # measure a real install; fails if the dependency budget grows
```

`npm run weigh` is the guard on the only number this package exists for. If you
add a dependency, it will argue with you.
