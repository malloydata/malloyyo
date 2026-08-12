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
  // Optional — needed only for private GitHub repos.
  get GITHUB_TOKEN() {
    return process.env.GITHUB_TOKEN ?? "";
  },
  // Whether an unauthenticated caller may read public datasets. The read routes
  // that list datasets/sources, and the one that returns a dataset's model
  // source and files, otherwise fall back to a public-only query when there is
  // no session. On a deployment whose whole point is that only staff can see
  // the model (SSO-gated, EMAIL_ALLOW_LIST), "public" should mean "everyone
  // signed in here" — not "the internet". Defaults false so a missing or
  // misspelled value fails closed.
  get ALLOW_ANONYMOUS_PUBLIC_DATASETS(): boolean {
    return (process.env.ALLOW_ANONYMOUS_PUBLIC_DATASETS ?? "false").trim().toLowerCase() === "true";
  },
  // Optional GA4 Measurement ID (G-XXXXXXXXXX). Unset means this deployment
  // ships no third-party script and sets no cookies — the same default the
  // static `dashboard bundle` sites use, where the ID lives in
  // malloy-config.json instead.
  get ANALYTICS_ID() {
    return process.env.ANALYTICS_ID ?? "";
  },
};
