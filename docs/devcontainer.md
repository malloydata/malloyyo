# The development container

`Dockerfile.dev` builds a self-contained environment for working on a **Malloy
model repo**: VS Code in the browser, the toolchain under it, and the model repo
cloned inside the container. It is not the server image — that is `Dockerfile`,
covered in [docker.md](./docker.md).

Published at `ghcr.io/malloydata/malloyyo-dev`, for `linux/amd64` and
`linux/arm64`.

## Start one

```bash
docker run -d --name malloyyo \
  -p 127.0.0.1:8080:8080 \
  -v malloyyo-home:/home/node \
  -e REPO_URL=https://github.com/malloydata/malloyyo-ecommerce \
  ghcr.io/malloydata/malloyyo-dev:latest

docker logs malloyyo    # prints the URL and the generated password
```

Open <http://localhost:8080/>. The repo is cloned to `/home/node/workspace`;
nothing touches your filesystem.

**One published port.** Dashboards are reached through code-server's proxy —
`http://localhost:8080/proxy/4173/` for `malloyyo dashboard dev`, and the same for
whatever `--port` you pick, with nothing to republish. Add `-p 4173:4173` if you
would rather hit the dashboard server directly.

Leave `REPO_URL` off and you get an empty workspace and a terminal — clone
whatever you like from there.

## What's inside

| | |
| --- | --- |
| code-server | VS Code over HTTP, with the Malloy extension pre-installed |
| `malloyyo` | pinned, so the image and the project can't drift |
| `claude` | Claude Code |
| `gcloud`, `bq` | Google Cloud SDK — BigQuery models |
| `gh` | GitHub CLI |
| node 24, build toolchain, `sudo` | `lz4` compiles on install; without it nothing installs |

About **900 MB to pull**, ~3 GB unpacked. (`docker images` reports a larger
number — it sums layers and double-counts overwrites.) The Google Cloud SDK is
~730 MB of that and code-server another ~350 MB. The trade is deliberate: pull
once, and never ask an analyst to install a C++ toolchain before a first query.

## Your work lives in the volume

The repo is inside the container, so **`docker rm` destroys anything not
pushed** — `-v malloyyo-home:/home/node` is what makes that survivable. It covers
the working tree *and* `~/.config`, so your logins persist too; without it you
re-authenticate to everything on each restart.

Start without a volume and the container says so, loudly, at boot. It also never
clones over a populated workspace — if there is already work in there, it says
what it found and leaves it alone.

## Signing in

**Claude Code** — `claude auth login`, from the code-server terminal or
`docker exec -it malloyyo claude auth login`. It prints a URL; open it, approve,
and paste the code back at the prompt. No port needed: the OAuth redirect
terminates on Anthropic's servers, not on localhost. `claude setup-token` gets
you a long-lived token instead.

**Malloyyo** — `malloyyo login`. Where there is no browser to open (here, a
Codespace, SSH, CI) it uses the device flow: it prints a URL and a short code;
open the URL on any machine, sign in if you are not already, and type the code.
Nothing listens and no port is involved. On a laptop it keeps the one-click
loopback redirect instead; `malloyyo login --device` asks for the code flow
anywhere.

(Against an instance too old to offer the device flow, the CLI falls back to the
loopback redirect, which does need a reachable port: set `MALLOYYO_OAUTH_PORT`
and `MALLOYYO_OAUTH_HOST=0.0.0.0` and publish that port. Setting that port also
selects the loopback redirect on its own. Or use a token — `--token`, or the env
var named in your `malloyyo` config block.)

**Google / BigQuery** — `gcloud auth application-default login --no-launch-browser`.
That writes Application Default Credentials to `~/.config/gcloud`, which is what
`@malloydata/db-bigquery` reads. For CI, or anywhere interactive sign-in doesn't
belong, use a service account key instead: `{"env": "BQ_JSON_KEY"}` in
`malloy-config.json`. No gcloud involved.

**GitHub** — `gh auth login --web` prints a code to paste; a device flow, so it
needs nothing published.

## Security

code-server is a terminal in a browser, running as a user that holds your cloud
credentials. Two rules:

- **Publish to `127.0.0.1:8080`, never `0.0.0.0:8080`.** Otherwise anyone on your
  network has a shell with your ADC.
- **Leave password auth on.** One is generated on first boot and written to
  `~/.config/code-server/config.yaml`; startup prints it.

Serving this to other people is a different problem — multi-tenant code
execution — and is not what this image is for.

## Or as a dev container

The same image works as a `devcontainer.json` base, if you'd rather use VS Code
Desktop and keep the repo on your own disk. The entrypoint notices the workspace
is already populated and skips the clone.

```jsonc
{
  "name": "malloy-model",
  "image": "ghcr.io/malloydata/malloyyo-dev:latest",
  "overrideCommand": true,
  "forwardPorts": [4173],
  "customizations": {
    "vscode": { "extensions": ["malloydata.malloy-vscode"] }
  }
}
```

Add bind mounts for `~/.config/gcloud`, `~/.config/malloyyo`, `~/.config/gh` and
`~/.claude` if you want the container to reuse logins you already have on the
host. Those paths must exist first.

## Other warehouses

Postgres, MySQL, Snowflake, Trino and Databricks connectors all ship inside
`@malloydata/malloy-connections`, so they are already present — a connection in
`malloy-config.json` is all they need. What each may still want is its own
interactive sign-in; Snowflake's browser SSO has the same constraint as the
others, and the same workarounds.

## Pinning

`:latest` moves. For a repo where everyone should be on the same toolchain, name
a version (`:0.2.40`) or the immutable digest the publish workflow prints.
