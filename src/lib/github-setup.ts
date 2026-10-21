// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The GitHub half of guided setup: does a token read this repo, and a webhook
// secret to give GitHub and this instance.
//
// The token is `GITHUB_TOKEN` (src/lib/env.ts) — the customer's own, deliberately
// settable on Malloyyo Cloud. A fine-grained token with read access to THIS repo
// (Contents + Metadata: read-only) is all publishing and checking need. The
// webhook secret is `GITHUB_WEBHOOK_SECRET` (src/lib/github-webhook.ts), which
// makes a push to the published branch publish.

import { randomBytes } from "node:crypto";
import { githubRepoFromRemote } from "./repo-names";

export type TokenTest =
  | { ok: true; repo: string; private: boolean; defaultBranch: string }
  | { ok: false; error: string };

/**
 * Can `token` (or GITHUB_TOKEN, when omitted) read `repo`'s contents? Asks for
 * a commit, not just the repo: a token with metadata-only access sees the repo
 * and still can't fetch what publishing needs.
 */
export async function testGitHubToken(repoRaw: string, token?: string): Promise<TokenTest> {
  const repo = githubRepoFromRemote(repoRaw);
  if (!repo) return { ok: false, error: `"${repoRaw}" isn't a GitHub repo (owner/name)` };
  const t = token?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!t) return { ok: false, error: "GITHUB_TOKEN isn't set in this instance's environment yet" };
  const headers = {
    authorization: `Bearer ${t}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "malloyyo-setup",
  };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (r.status === 401) return { ok: false, error: "GitHub rejected the token (expired, revoked, or mistyped)" };
    if (r.status === 404 || r.status === 403) {
      return { ok: false, error: `the token can't see ${repo} — give it access to this repository` };
    }
    if (!r.ok) return { ok: false, error: `GitHub answered ${r.status}` };
    const meta = (await r.json()) as { private?: boolean; default_branch?: string };
    const c = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers });
    // An empty repository answers 409 with the right access: nothing to read yet, but readable.
    if (!c.ok && c.status !== 409) {
      return { ok: false, error: `the token sees ${repo} but can't read its contents — grant Contents: Read-only` };
    }
    return { ok: true, repo, private: meta.private ?? false, defaultBranch: meta.default_branch ?? "main" };
  } catch (err) {
    return { ok: false, error: `couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A fresh webhook secret: 32 random bytes, hex. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * GitHub's "new fine-grained token" page. The query parameters prefill it
 * where GitHub honours them; the person still picks the repository.
 */
export function newTokenUrl(instanceName: string): string {
  const q = new URLSearchParams({
    name: `Malloyyo (${instanceName})`,
    description: "Read access for publishing this Malloy model repo",
    contents: "read",
    metadata: "read",
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

/** The repo's "add webhook" page. */
export function newWebhookUrl(repo: string): string {
  return `https://github.com/${repo}/settings/hooks/new`;
}
