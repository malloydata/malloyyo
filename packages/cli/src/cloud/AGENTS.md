# `malloyyo cloud` — rules for agents

The command group for Malloyyo-**hosted** instances. It is a thin client for the
control-plane API; the separately deployed service owns the wire contract and pins it
from its side.

**This directory is public source.** Keep the names of the services Malloyyo runs on out of
it — comments included. A customer reaches their instance at its `malloyyo.com` hostname and
never contacts any of them, so naming one here describes our topology for no benefit and
invites someone to build an expectation on it. Say "the control plane", "the instance host",
"something in front of it". There is no longer any exception: the identity provider used to
be visible as a dependency, and moving the credential exchange to the control plane
(`POST /v1/token`) is what removed it. Do not reintroduce a provider SDK here.

These rules came across with the code and are load-bearing here. Most of them are the
reason a line looks the way it does, so "simplifying" one is how it gets lost.

- **Thin client, not a second control plane.** This code holds no infrastructure
  credential and makes no call to anything but Malloyyo's own API. Everything
  else goes through the control-plane API. Never add a command that talks to a provider
  directly.
- **Least privilege per command.** Each command's token carries only the scopes it needs
  (`COMMAND_SCOPES`). The mutating commands carry `instances:read` as well because they
  poll the operation they open, and the control plane gates that GET on read — a bare
  mutation token 403s on its first poll. An `instance list` must never request
  `instances:create`, and nothing outside the `secrets` command group may request
  `secrets:write` — all three of its verbs use it, listing included, because names and
  digests are what the write scope already learns from every set and unset response.
- **The credential exchange goes to the control plane, never to an identity provider.**
  `POST /v1/token` takes the credential and returns a token; that is one ordinary OAuth 2.0
  client-credentials request with nothing bespoke in it. Calling a provider directly instead
  would put its SDK in a binary customers install, name the provider in public source, and
  weld a tool upgraded on the customer's schedule to a choice we may revisit — which is
  exactly why it was moved. Do not add a provider SDK back.
- **The token is cached, and that is not an optimization to drop.** `create` polls its
  operation; without `createCachedTokenSource` every poll would spend a network round trip
  getting a token before the one it actually wanted. Concurrent callers share one in-flight
  exchange for the same reason.
- **Never log or persist the client secret.** It is read from the environment into memory
  and handed to the token source; it appears in no output, no file, and no error message.
- **A secret value is never printed, quoted back, or put in an error message.**
  `secrets set` echoes names. A malformed `NAME=value` argument is reported by its
  *position*, because the one thing a malformed argument might be is the credential itself,
  typed without its `NAME=`. `parseSecretArguments` splits on the first `=` only: a
  connection string or a base64 key contains more.
- **A secret must be able to reach the CLI without touching the command line.** A bare
  `NAME` prompts with the input hidden; `--stdin` reads `NAME=value` lines. Both exist
  because neither covers the other — piping means `echo 'PG_PASSWORD=…' | …`, which puts
  the value straight back in the history file. `promptSecret` is supplied *only* when
  stdin is a TTY, and that absence is what makes a bare `NAME` under a pipe fail with "use
  `--stdin`" instead of hanging on input that is never coming.
- **`--stdin` interprets nothing.** No unquoting, no `$` expansion, no trimming of a
  value's trailing whitespace — only blank lines, `#` comments, and the `\r` of a CRLF.
  A parser that "helpfully" cleaned a credential produces an authentication failure with
  no visible cause from outside the instance.
- **Every request goes through `apiFetch`.** That is what puts the `malloyyo/<version>`
  user agent on control-plane calls and turns an upgrade-required answer into an
  instruction. One wrapper covers instance and control-plane calls alike; a client that
  quietly used its own `fetch` would satisfy the type and break the rule.
- **Mutations carry an `Idempotency-Key`, and the retry is what makes it mean something.**
  A transient failure (network error, 5xx, 429) is retried under the *same* key inside
  `api.ts`. Never retry under a fresh key, and never make a mutating call without one —
  either turns a lost answer into a duplicate instance or a false conflict.
- **`secrets set` waits out `instance_busy`, and only that.** The control plane gives the
  busy conflict its own code precisely so a client can tell "wait, this resolves itself"
  from "change your request". The wait is under the same key, safe because a busy answer
  opened no operation. Widening it to other 409s would hang the command until its deadline
  on a request that can never succeed.
- **Never invent server behavior.** Success bodies are `{ instance }` / `{ instances }` /
  `{ operation }` / `{ instance, operation }`; errors are `{ error, message? }`. `api.ts`
  mirrors exactly that — including that a DELETE's `operation` is **nullable** and no other
  endpoint's is. Mirror it in the *types*, not with a cast: an unchecked `as` turns a
  wrong-endpoint answer into a `TypeError` several frames away.
- **An operation the CLI stopped waiting on has not failed.** The commands bound how long
  they block, then tell the user to check `instance status`. They exit non-zero only on a
  real `failed` operation.
- **`runCloud` stays process-free — and it never throws.** Every failure leaves as an exit
  code. Only `index.ts` touches `process`, stdin, and the terminal.
- **Step labels are keyed on the control plane's *public* step names.** The internal names
  those translate from identify the infrastructure behind an instance and never leave the
  server. A step with no label is skipped rather than printed raw.

## Testing

Fake the boundaries this code does not own: `fetch` for the API client (asserting request
shape and response parsing against the control plane's documented contract — the oracle),
and a `ControlPlaneClient` for the command handlers and `runCloud`. Inject the
idempotency-key generator and the clock so operation polling is deterministic. Tests live
in `packages/cli/test/cloud-*.test.ts` and run under `node:test` like the rest of the CLI's.
