// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { env } from "./env";

// GitHub's contents API intermittently returns transient errors under load
// (spurious 400s, secondary-rate-limit 403/429, 5xx) — a model refresh fetches
// many files, so retry those a few times with backoff before giving up. 401
// (auth) and 404 (missing) are definitive and never retried.
const RETRYABLE = new Set([400, 403, 408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with backoff on transient GitHub errors. A model refresh makes many
    contents-API calls, and GitHub intermittently returns spurious 400s and
    secondary-rate-limit 403/429s under that load — retry those; 401 (auth) and
    404 (missing) are definitive. */
/** The headers every GitHub call sends. One place, because this was written
    five times and a change applied to four of them is a bug that shows up on
    exactly one code path. */
function githubHeaders(useToken: boolean, accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (useToken && env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      if (attempt >= 3) throw e; // network error
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (res.ok || !RETRYABLE.has(res.status) || attempt >= 3) return res;
    await sleep(300 * 2 ** attempt); // 300ms, 600ms, 1200ms
  }
}

export async function fetchGitHubFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  opts: { useToken?: boolean } = {},
): Promise<string> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const headers = githubHeaders(useToken, "application/vnd.github.raw+json");

  const res = await githubFetch(url, headers);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message ?? ""; } catch { /* ignore */ }

    if (res.status === 401) {
      throw new Error(
        `GitHub authentication failed fetching ${path}.\n` +
        (detail ? `GitHub says: ${detail}\n` : "") +
        `If this is a public repo, uncheck "Use GITHUB_TOKEN" and try again.`
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Not found: ${path} in ${owner}/${repo}@${branch}.\n` +
        `Check the repo name, branch, and that index.malloy exists at the root.`
      );
    }
    throw new Error(
      `GitHub returned ${res.status} fetching ${path} from ${owner}/${repo}@${branch}` +
      (detail ? `: ${detail}` : "")
    );
  }
  return res.text();
}

export class GitHubURLReader {
  readonly fetched = new Map<string, string>();

  constructor(
    private owner: string,
    private repo: string,
    private branch: string,
    private useToken: boolean = true,
  ) {}

  async readURL(url: URL): Promise<string> {
    const path = url.pathname.replace(/^\//, "");
    if (this.fetched.has(path)) return this.fetched.get(path)!;
    const content = await fetchGitHubFile(this.owner, this.repo, this.branch, path, {
      useToken: this.useToken,
    });
    this.fetched.set(path, content);
    return content;
  }
}

/**
 * The whole repo, in ONE request.
 *
 * This is how a repo should be read. The contents API costs a request per file,
 * and an instance with no GITHUB_TOKEN has sixty an hour for everything — a
 * four-dataset repo spent all sixty on a single refresh, measured twice. The
 * archive is also what `malloyyo publish` sends, so both ways a repo arrives
 * reach the same extractor (src/lib/tarball.ts).
 *
 * Returns null when GitHub will not give it, so a caller can fall back to
 * reading files one at a time rather than failing outright.
 */
export async function fetchGitHubTarball(
  owner: string,
  repo: string,
  ref: string,
  opts: { useToken?: boolean } = {},
): Promise<Buffer | null> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
  const headers = githubHeaders(useToken, "application/vnd.github+json");

  const res = await githubFetch(url, headers);
  if (!res.ok) return null;
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The whole repo as a ZIP, in one request.
 *
 * Preferred over the tarball above, because zip is what a revision is STORED as
 * (src/db/schema.ts) and this way the bytes GitHub sends need no conversion:
 * one request, one format, one reader. The reason for zip over `.tar.gz` is that
 * gzip is a single stream and cannot be read partially, while a zip has a
 * central directory with per-member offsets — so one dataset's files can be read
 * without inflating the rest, and a member's uncompressed size is known before
 * anything is inflated, which is what bounds a decompression bomb.
 *
 * Returns null when GitHub will not give it, so a caller can say why rather than
 * throw a fetch error at someone reading a log.
 */
export async function fetchGitHubZipball(
  owner: string,
  repo: string,
  ref: string,
  opts: { useToken?: boolean } = {},
): Promise<Buffer | null> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`;
  const res = await githubFetch(url, githubHeaders(useToken, "application/vnd.github+json"));
  if (!res.ok) return null;
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The commit a branch currently points at.
 *
 * Recorded on every model a repo refresh writes, which is what makes "these
 * four datasets are at the same commit" a checkable fact rather than an
 * intention. Before this, a GitHub-backed model recorded only
 * `github:owner/repo@branch` — the branch, never which commit of it — so a repo
 * whose datasets had drifted apart looked exactly like one that had not.
 *
 * Null when it cannot be read: a refresh should not fail for want of a label.
 */
export async function fetchGitHubCommitSha(
  owner: string,
  repo: string,
  branch: string,
  opts: { useToken?: boolean } = {},
): Promise<string | null> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`;
  const headers = githubHeaders(useToken, "application/vnd.github+json");
  const res = await githubFetch(url, headers);
  if (!res.ok) return null;
  const body = (await res.json()) as { sha?: string };
  return typeof body.sha === "string" ? body.sha : null;
}

/**
 * Every path in the repo, in ONE request (the git trees API, recursive).
 *
 * The Contents API costs a request per directory, and discovering a
 * multi-dataset repo walks the root, `datasets/`, and each dataset inside it —
 * so a four-dataset repo spent six requests before reading a single model. An
 * instance with no GITHUB_TOKEN has sixty requests an hour for everything, and
 * adding one repo could spend most of them.
 *
 * Returns null when the tree cannot be read (a rate limit, a missing branch, or
 * GitHub's `truncated` flag on a repo too large to return whole), so callers
 * fall back to walking directories rather than treating "no tree" as "no files".
 */
export async function listGitHubTree(
  owner: string,
  repo: string,
  branch: string,
  opts: { useToken?: boolean } = {},
): Promise<GitHubDirEntry[] | null> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const headers = githubHeaders(useToken, "application/vnd.github+json");

  const res = await githubFetch(url, headers);
  if (!res.ok) return null;
  const body = (await res.json()) as { tree?: { path: string; type: string }[]; truncated?: boolean };
  // A truncated tree is a PARTIAL answer, and a partial answer here reads as
  // "that dataset directory does not exist" — the one shape of wrong that
  // silently publishes less than the author wrote.
  if (body.truncated || !Array.isArray(body.tree)) return null;
  return body.tree.map((e) => ({
    name: e.path.split("/").pop() ?? e.path,
    path: e.path,
    type: e.type === "tree" ? ("dir" as const) : ("file" as const),
  }));
}

/** A `listGitHubDir`-shaped view over a whole-repo tree: the direct children of
    `path` ("" being the root). Lets the layout rules run against one fetch. */
export function dirFromTree(tree: GitHubDirEntry[], path: string): GitHubDirEntry[] {
  const prefix = path ? `${path.replace(/\/+$/, "")}/` : "";
  const out: GitHubDirEntry[] = [];
  for (const e of tree) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue; // not a direct child
    out.push(e);
  }
  return out;
}

export interface GitHubDirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/**
 * List a directory in the repo via the Contents API. Returns [] if the path
 * doesn't exist (404) or isn't a directory — callers treat "no dashboards/" as
 * simply having no dashboards.
 */
export async function listGitHubDir(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  opts: { useToken?: boolean } = {},
): Promise<GitHubDirEntry[]> {
  const useToken = opts.useToken !== false;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const headers = githubHeaders(useToken, "application/vnd.github+json");

  const res = await githubFetch(url, headers);
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} listing ${path} in ${owner}/${repo}@${branch}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return []; // a file, not a dir
  return body.map((e) => {
    const entry = e as { name: string; path: string; type: "file" | "dir" };
    return { name: entry.name, path: entry.path, type: entry.type };
  });
}

export function parseGitHubRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository format "${repo}" — expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}
