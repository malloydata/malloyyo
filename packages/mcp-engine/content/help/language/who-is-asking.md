---
description: Per-user data with $MALLOYYO_EMAIL — the reserved given this server fills from the signed-in user, how to declare it, and how to run the model locally
---

# Who is asking — `$MALLOYYO_EMAIL`

A model can scope what a query returns to the person running it. Declare the
reserved given, then use it like any other:

```malloy
##! experimental.givens
given:
  MALLOYYO_EMAIL :: string is ''

source: orders is duckdb.table('orders.parquet') extend {
  where: owner_email = $MALLOYYO_EMAIL
}
```

Every query against that model — the `query` tool, a dashboard tile, a saved
query, an ltool link — binds it to the signed-in user's address. Nothing else
changes: no per-user models, no filtered copies, no query rewriting.

**The declaration is the opt-in.** A model that does not declare it is
untouched, because supplying a given a model never declared is an error in
Malloy rather than a no-op.

## What a caller cannot do

A caller may not set it. A `givens: { "MALLOYYO_EMAIL": "someone@else.com" }`
on a `query` call, a dashboard's `?MALLOYYO_EMAIL=` URL, a value baked into a
component — all dropped before the query compiles, and the signed-in address
bound instead. That is the whole point of the feature; do not design around it.

For the same reason it is not offered as a filter: `query(execute:false)` does
not list it among the givens to supply, and a dashboard renders no control for
it.

## The `MALLOYYO_` prefix is reserved

`MALLOYYO_EMAIL` is the only one that exists. Declaring any other
`MALLOYYO_*` given is refused at publish — the prefix means "a value this
server vouches for", and a `$MALLOYYO_ROLE` the server does not fill would read
as though it did. Name your own givens anything else.

## Running it locally

Locally there is no one asking, so the declaration default applies and a
tenant-scoped query comes back empty — which looks exactly like a broken
dashboard. Put a stand-in in `malloy-config.json`:

```json
{
  "malloyyo": {
    "test_givens": { "MALLOYYO_EMAIL": "you@example.com" }
  }
}
```

`malloyyo dashboard dev`, `malloyyo dashboard bundle`, `malloyyo lint` and the
CLI's own MCP server all bind it the way the server binds the real one, so what
you see locally is what a reader gets. Change the address to see another
tenant's view.

The block is **local only** — the server never reads it. It travels with the
repo, so if it were honored a repo could name any address and read that
person's rows.

## Notes

- Give it a default (`is ''`) and make sure the default is the SAFE answer.
  An empty address matching no rows is right; a default that matches
  everything is a model that shows everything to a caller the binder could not
  identify.
- Filtering belongs in the source (`extend { where: … }`), not in each query —
  that way it holds for every query anyone writes against it, including ones
  an agent composes later.
- It is a string, not a verified claim about identity beyond sign-in: it is the
  address the signed-in account carries.
