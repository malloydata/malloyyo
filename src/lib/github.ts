// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { env } from "./env";

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

  const res = await fetch(url, { headers });
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

export function parseGitHubRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository format "${repo}" — expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}
