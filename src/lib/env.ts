// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  // Optional — when unset, Malloy runs against plain (in-memory) DuckDB
  // instead of MotherDuck; models supply their own sources/attachments.
  get MOTHERDUCK_TOKEN() {
    return process.env.MOTHERDUCK_TOKEN ?? "";
  },
  get MOTHERDUCK_DATABASE() {
    return process.env.MOTHERDUCK_DATABASE ?? "mayolo";
  },
  get APP_BASE_URL() {
    return process.env.APP_BASE_URL ?? "http://localhost:3000";
  },
  // Human-readable name for this deployment, shown in the UI, the MCP
  // serverInfo, and prefixed onto every tool description so Claude can tell
  // multiple connected Malloyyo instances apart.
  get INSTANCE_NAME() {
    return process.env.INSTANCE_NAME ?? "Malloyyo";
  },
  // The commit this build was made from, when the platform says so. Vercel sets
  // VERCEL_GIT_COMMIT_SHA on every build of a git-connected project (including a
  // `vercel --prod` from a working tree, where it reflects the local HEAD).
  // GIT_COMMIT_SHA is the portable spelling a self-hosted deployment can set in
  // its own environment — it is read at runtime, so a Docker image takes it from
  // `-e GIT_COMMIT_SHA=…` with no rebuild and no Dockerfile change.
  //
  // Absent is a normal state, not an error: `npm run dev` has neither, and the
  // UI simply shows the version alone.
  get BUILD_SHA(): string | undefined {
    const sha = process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA;
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : undefined;
  },
  // Short slug prefix for this deployment (e.g. main / stg / gld). Prefixed
  // onto shareable query slugs so a slug from one instance fails loudly when
  // handed to another.
  get INSTANCE_CODE() {
    return (process.env.INSTANCE_CODE ?? "main").toLowerCase();
  },
  // Comma-separated list of Google emails that are automatically admins.
  get APP_ADMIN_EMAILS(): string[] {
    return (process.env.APP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  // Optional — needed for private GitHub repos, and without any token public-repo
  // fetches run against GitHub's anonymous 60/hour-per-IP budget, which on shared cloud
  // egress is usually already spent by other tenants of the address.
  //
  // `GITHUB_TOKEN_FALLBACK` is a second name an operator can set platform-wide (Malloyyo
  // hosting provisions a scopeless one into every instance); the user's own GITHUB_TOKEN
  // always wins when present. Two names — rather than the platform writing GITHUB_TOKEN —
  // so a user setting, replacing, emptying, or removing their token never collides with
  // the platform's. `||` not `??`: an empty GITHUB_TOKEN means "unset", and must fall
  // through rather than authenticate as nobody.
  get GITHUB_TOKEN() {
    return process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_FALLBACK || "";
  },
  // Optional — the key that turns on Ask (natural-language → Malloy in ltool).
  // Absent is the normal state and the whole feature is simply off: no key, no
  // Ask box, and /api/ask answers 503. There is one key per deployment, so every
  // signed-in user's questions are billed to the operator who set it — see
  // src/lib/ask.ts for the loop's own cost bounds (a hard step cap, a row cap on
  // what it may read, one dataset's schema in context).
  get ANTHROPIC_API_KEY() {
    return process.env.ANTHROPIC_API_KEY ?? "";
  },
  // Required when ANTHROPIC_API_KEY is an identity-linked key: such keys act
  // inside a workspace and the API rejects a request that doesn't name one
  // ("anthropic-workspace-id is required when authenticating with an
  // identity-linked API key"). An ordinary key needs no workspace and ignores
  // this, so it stays unset by default.
  get ANTHROPIC_WORKSPACE_ID() {
    return process.env.ANTHROPIC_WORKSPACE_ID ?? "";
  },
  // Which model writes the Malloy. Sonnet is the default: it shares Opus's
  // request shape (adaptive thinking, the full effort ladder), so moving between
  // them is this one string, and it is markedly better at Malloy than Haiku —
  // which matters more than the sticker price, because every query that fails to
  // compile costs another round trip carrying the whole conversation.
  //
  // Older-generation models (claude-haiku-4-5) take a different thinking
  // parameter and reject `effort`; modelShape in src/lib/ask.ts shapes the
  // request per model, so setting one here works without further changes.
  get ANTHROPIC_MODEL() {
    return process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  },
  // Optional GA4 Measurement ID (G-XXXXXXXXXX). Unset means this deployment
  // ships no third-party script and sets no cookies — the same default the
  // static `dashboard bundle` sites use, where the ID lives in
  // malloy-config.json instead.
  get ANALYTICS_ID() {
    return process.env.ANALYTICS_ID ?? "";
  },
  // Malloyyo product telemetry is distinct from the deployment owner's optional
  // GA4 configuration above. The hosted control plane sets the immutable tenant
  // and account IDs; their presence also makes the self-hosted opt-out inapplicable.
  get MALLOYYO_TENANT_ID() {
    return process.env.MALLOYYO_TENANT_ID ?? "";
  },
  get MALLOYYO_ACCOUNT_ID() {
    return process.env.MALLOYYO_ACCOUNT_ID ?? "";
  },
  get MALLOYYO_TELEMETRY_DISABLED() {
    return process.env.MALLOYYO_TELEMETRY_DISABLED === "1";
  },
  get MALLOYYO_TELEMETRY_DEBUG() {
    return process.env.MALLOYYO_TELEMETRY_DEBUG === "1";
  },
};
