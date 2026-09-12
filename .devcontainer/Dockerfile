# syntax=docker/dockerfile:1

# The Malloyyo development container: one image that any Malloy model repo can
# open a GitHub Codespace (or a local Dev Container) on and be ready to work —
# Claude Code, the Malloy and Claude VS Code extensions, the `malloyyo` CLI, a
# Node toolchain for the React side of dashboards, and enough gcloud to
# authenticate against BigQuery.
#
# WHY IT LIVES HERE, AND NOT IN EVERY MODEL REPO. Building this from scratch on
# codespace creation costs minutes (three apt repositories, a Chromium download,
# four global npm installs). `.github/workflows/devcontainer.yml` builds it once
# per change to this directory and publishes it to
# ghcr.io/malloydata/malloyyo-devcontainer, so a model repo's devcontainer.json
# is one line — an `image` reference — and creating its codespace is a pull.
#
# THE `devcontainer.metadata` LABEL AT THE BOTTOM IS THE OTHER HALF OF THAT.
# Dev Containers merges image-carried metadata into the effective configuration,
# so the extensions, the forwarded dashboard ports and the remote user ride
# along with the image itself. A consuming repo gets the whole environment from
# the `image` line alone and only writes down what is genuinely its own.
#
# Everything installed here is the LATEST of its line on purpose (the CLI, Claude
# Code, DuckDB, Chromium): the image is rebuilt weekly, and a model repo pulling
# `:latest` should get current tools. Pin to a `:sha-…` tag if you need a fixed
# environment — see docs/devcontainer.md.

FROM mcr.microsoft.com/devcontainers/base:2-bookworm

# Node's line. Kept in step with mise.toml / CI / the Vercel Functions runtime —
# a container that develops against a different major than the one that ships is
# the whole problem this repo's mise.toml pin exists to avoid.
ARG NODE_MAJOR=24

# npm's global prefix, moved off /usr/local/lib and handed to `vscode`, so
# `npm i -g @malloydata/malloyyo@latest` mid-session works without sudo. This is
# the same layout the Microsoft javascript-node images use.
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=${NPM_CONFIG_PREFIX}/bin:${PATH}

# Chromium lives outside any one project's node_modules so every repo opened in
# this container finds the browser that is already here. The directory is
# writable by `vscode`, so a project pinned to a different Playwright version can
# still install its own build alongside rather than failing.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

ENV NEXT_TELEMETRY_DISABLED=1

# Base tooling. build-essential + python3 are node-gyp's prerequisites — DuckDB's
# node bindings are the ones that need them.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates \
        curl \
        gnupg \
        unzip \
        jq \
        less \
        git-lfs \
    && git lfs install --system --skip-repo \
    && rm -rf /var/lib/apt/lists/*

# Node, the GitHub CLI and the Google Cloud CLI, in one apt transaction — three
# repositories, one `apt-get update`, one layer.
#
# google-cloud-cli is the full package deliberately: it carries `bq`, which is
# how you sanity-check a BigQuery-backed model outside Malloy, and
# `gcloud auth application-default login`, which is what Malloy's BigQuery
# connector actually reads.
RUN install -d -m 0755 /usr/share/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs gh google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# The global CLIs.
#   @anthropic-ai/claude-code — `claude` in the terminal; the VS Code extension
#     below drives this same binary, so both surfaces are live.
#   @malloydata/malloyyo      — `malloyyo init/lint/publish/dashboard dev/mcp`.
#   typescript, tsx           — a compiler and a TS runner that exist before any
#     project's `npm install` does.
#   playwright                — the driver for the Chromium installed next.
RUN mkdir -p ${NPM_CONFIG_PREFIX} \
    && npm install -g --no-fund --no-audit \
        @anthropic-ai/claude-code \
        @malloydata/malloyyo \
        typescript \
        tsx \
        playwright \
    && npm cache clean --force \
    && chown -R vscode:vscode ${NPM_CONFIG_PREFIX}

# Chromium + its system libraries, so Claude can open a dashboard it just wrote
# and look at it instead of guessing from the HTML. The `apt-get update` is not
# redundant: the layer above emptied /var/lib/apt/lists, and `--with-deps`
# shells out to apt for the browser's shared libraries.
RUN apt-get update \
    && mkdir -p ${PLAYWRIGHT_BROWSERS_PATH} \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R vscode:vscode ${PLAYWRIGHT_BROWSERS_PATH}

# The DuckDB CLI — the shell for the engine Malloy runs on by default, for
# poking at a Parquet or CSV file before modelling it.
#
# `releases/latest/download` rather than a pinned version: this is a developer
# convenience, the weekly rebuild keeps it current, and a pin here would rot
# silently. The asset name changed across DuckDB's arm64 releases, hence the
# fallback.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    base="https://github.com/duckdb/duckdb/releases/latest/download"; \
    case "$arch" in \
      amd64) assets="duckdb_cli-linux-amd64.zip" ;; \
      arm64) assets="duckdb_cli-linux-arm64.zip duckdb_cli-linux-aarch64.zip" ;; \
      *) echo "no DuckDB CLI build for $arch" >&2; exit 1 ;; \
    esac; \
    for a in $assets; do \
      if curl -fsSL -o /tmp/duckdb.zip "$base/$a"; then break; fi; \
    done; \
    test -s /tmp/duckdb.zip; \
    unzip -o -d /usr/local/bin /tmp/duckdb.zip; \
    rm /tmp/duckdb.zip; \
    chmod +x /usr/local/bin/duckdb; \
    duckdb -c "select 'duckdb ' || version()"

# Debian's /etc/profile OVERWRITES PATH, and both bash and zsh login shells run
# it — which is exactly what a VS Code terminal in this container is. Without
# this, `malloyyo` and `claude` resolve during the build (ENV) and then vanish
# for the person typing. profile.d is sourced after that overwrite, so it wins.
COPY <<'EOF' /etc/profile.d/10-malloyyo.sh
export NPM_CONFIG_PREFIX=/usr/local/share/npm-global
case ":$PATH:" in
  *":$NPM_CONFIG_PREFIX/bin:"*) ;;
  *) export PATH="$NPM_CONFIG_PREFIX/bin:$PATH" ;;
esac
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
EOF

# What to do next. A consuming devcontainer.json wires this to
# postAttachCommand, so it prints into each new terminal: a model repo gets
# opened by people who have never used this CLI, and the commands that matter
# (author, preview, authenticate against BigQuery) are not guessable.
COPY <<'EOF' /usr/local/bin/malloyyo-devcontainer-info
#!/usr/bin/env bash
# Printed when a terminal attaches. Quiet by design — one screen, no network.
set -u
printf '\n\033[1mMalloyyo dev container\033[0m — %s · node %s · %s\n' \
  "malloyyo $(malloyyo --version 2>/dev/null || echo '?')" \
  "$(node --version 2>/dev/null)" \
  "$(gcloud --version 2>/dev/null | head -1 || echo 'gcloud ?')"
cat <<'TXT'

  claude                        author the model with Claude (this repo's .mcp.json)
  malloyyo lint                 compile every .malloy file
  malloyyo dashboard dev        dashboard preview on port 4173 (auto-forwarded)
  malloyyo login <instance>     sign in once, then `malloyyo publish` to push

  BigQuery:  gcloud auth login --no-launch-browser
             gcloud auth application-default login --no-launch-browser
             gcloud config set project <project-id>

TXT
EOF
RUN chmod +x /usr/local/bin/malloyyo-devcontainer-info

LABEL org.opencontainers.image.source="https://github.com/malloydata/malloyyo" \
      org.opencontainers.image.description="Dev container for Malloyyo model repos: Claude Code, the Malloy + Claude VS Code extensions, the malloyyo CLI, Node 24, Playwright/Chromium and the Google Cloud CLI." \
      org.opencontainers.image.licenses="MIT"

# Configuration carried BY THE IMAGE. Dev Containers, the devcontainer CLI and
# Codespaces all merge this into the effective devcontainer.json, so a consuming
# repo inherits the extensions, the dashboard ports and the remote user from the
# `image` line alone — and can still override or add to any of it.
#
# JSON on one logical line (LABEL takes no heredoc); the continuations are the
# Dockerfile parser's, not JSON's.
LABEL devcontainer.metadata='[{ \
  "remoteUser": "vscode", \
  "forwardPorts": [4173, 4174], \
  "portsAttributes": { \
    "4173": { "label": "Malloy dashboard preview", "onAutoForward": "notify" }, \
    "4174": { "label": "dashboard frame (untrusted origin)", "onAutoForward": "silent" } \
  }, \
  "customizations": { \
    "vscode": { \
      "extensions": [ \
        "anthropic.claude-code", \
        "malloydata.malloy-vscode", \
        "dbaeumer.vscode-eslint", \
        "esbenp.prettier-vscode", \
        "GitHub.vscode-pull-request-github" \
      ], \
      "settings": { \
        "files.associations": { "*.malloy": "malloy" }, \
        "terminal.integrated.defaultProfile.linux": "zsh" \
      } \
    } \
  } \
}]'
