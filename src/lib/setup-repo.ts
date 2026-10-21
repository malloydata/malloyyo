// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Guided setup's repo steps: register a brand-new GitHub repo with this
// instance (nothing to publish yet), and the starter files for it.
//
// Registering is NOT POST /api/datasets, which publishes on the spot and
// deletes the row if that fails — a new repo has nothing to publish, and a
// private one can't even be read until its GitHub token is set. The row just
// names the repo; the first publish (after the merge) fills it.

import { sql } from "drizzle-orm";
import { scaffoldFiles } from "@malloyyo/mcp-engine";
import { db, repos, type Repo } from "@/db";
import { env } from "./env";
import { githubRepoFromRemote, repoSlugFromGitHub } from "./repo-names";

type Fail = { ok: false; error: string };

export async function addRepo(
  githubRaw: string,
  ownerId: string,
  branch = "main",
): Promise<{ ok: true; repo: Repo; existed: boolean } | Fail> {
  const github = githubRepoFromRemote(githubRaw);
  if (!github) return { ok: false, error: `"${githubRaw}" isn't a GitHub repo (owner/name, or its URL)` };
  if (!/^[\w./-]{1,100}$/.test(branch) || branch.includes("..")) return { ok: false, error: `"${branch}" isn't a branch name` };
  const [existing] = await db
    .select()
    .from(repos)
    .where(sql`lower(${repos.githubRepo}) = ${github.toLowerCase()}`)
    .limit(1);
  if (existing) return { ok: true, repo: existing, existed: true };
  const slug = repoSlugFromGitHub(github);
  if (!slug) return { ok: false, error: `couldn't make a name out of "${github}"` };
  try {
    const [repo] = await db
      .insert(repos)
      .values({
        slug,
        ownerId,
        githubRepo: github,
        githubBranch: branch,
        // Private repos are the default: reads go through GITHUB_TOKEN once set.
        githubUseToken: true,
      })
      .returning();
    return { ok: true, repo, existed: false };
  } catch {
    return {
      ok: false,
      error: `a repo named "${slug}" already exists here, attached to a different GitHub repo. Rename the GitHub repo or ask an admin.`,
    };
  }
}

/**
 * The files a new model repo starts with — what `malloyyo init` writes, minus
 * what only a local checkout uses (.mcp.json, the devcontainer): the CLI's
 * skills, a CLAUDE.md naming this instance, .gitignore, an empty datasets/,
 * and a malloy-config.json that setup's connection step replaces.
 */
export function scaffoldFor(repo: Repo): Record<string, string> {
  const fill = (text: string) =>
    text
      .replaceAll("{{instance}}", env.INSTANCE_NAME)
      .replaceAll("{{url}}", env.APP_BASE_URL.replace(/\/$/, ""))
      .replaceAll("{{repo}}", repo.slug);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(scaffoldFiles)) files[path] = fill(text);
  files["datasets/.gitkeep"] = "";
  files["malloy-config.json"] = `${JSON.stringify({ connections: { duckdb: { is: "duckdb" } } }, null, 2)}\n`;
  return files;
}
