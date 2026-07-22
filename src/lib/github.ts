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

/** Normalize a repo subdirectory path: trim whitespace and slashes. Empty
    string = repo root. */
export function normalizeGitHubPath(path: string | null | undefined): string {
  return (path ?? "").trim().replace(/^\/+|\/+$/g, "");
}

/** Join a normalized base path and a repo-relative file path. */
export function joinRepoPath(basePath: string, path: string): string {
  return basePath ? `${basePath}/${path}` : path;
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
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (useToken && env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

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
        `Check the repo name, branch, and path — index.malloy must exist there.`
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
  /** Model-relative path → content. Keys are relative to `basePath` (e.g.
      "index.malloy", "dashboards/x.malloy") so Malloy import resolution and
      downstream storage are independent of where the model sits in the repo. */
  readonly fetched = new Map<string, string>();

  constructor(
    private owner: string,
    private repo: string,
    private branch: string,
    private useToken: boolean = true,
    /** Normalized subdirectory holding the model; "" = repo root. */
    private basePath: string = "",
  ) {}

  async readURL(url: URL): Promise<string> {
    const path = url.pathname.replace(/^\//, "");
    if (this.fetched.has(path)) return this.fetched.get(path)!;
    const content = await fetchGitHubFile(
      this.owner,
      this.repo,
      this.branch,
      joinRepoPath(this.basePath, path),
      { useToken: this.useToken },
    );
    this.fetched.set(path, content);
    return content;
  }
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
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (useToken && env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

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
