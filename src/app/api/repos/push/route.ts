// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/repos/push` — publish a whole repo.
 *
 * THE WIRE IS UNCHANGED. The CLI still sends `{repo, branch, archive,
 * createDatasets, git}` with a base64 gzipped tar, and still gets back
 * `{ok, repo, branch, datasets:[{name, version, created}]}`. An existing
 * `malloyyo` binary cannot tell the difference. What changed is everything
 * behind it: the archive is stored as a revision, verified, and activated by a
 * pointer flip (src/lib/repo-publish.ts).
 *
 * Two additive, optional fields a future CLI can send: `repoSlug` (name this
 * repo explicitly, the way out of a slug collision) and `archiveFormat`. A zip
 * is accepted today purely by sniffing its magic bytes, so a CLI that switches
 * needs no flag and no coordination.
 *
 * WHAT THIS ROUTE DECIDES is only authority and identity — which repo, may you
 * write to it, may you create it. The publish itself is the shared pipeline.
 */

import { NextResponse } from "next/server";
import { nameToSlug } from "@malloyyo/mcp-engine";
import { db, repos } from "@/db";
import { isAdmin } from "@/lib/admin";
import { credentialLabel, requireBearer } from "@/lib/bearer-auth";
import { logger, serializeErr } from "@/lib/logger";
import { storePreview } from "@/lib/repo-preview-store";
import { publishRevision } from "@/lib/repo-publish";
import { findRepoForPublish, repoSlugFromGitHub } from "@/lib/repos";
import { canAuthor } from "@/lib/roles";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const bad = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status });

type Body = {
  /** `owner/name`. Identifies the repo; does NOT attach it to GitHub. */
  repo?: string;
  /** The author's local branch. Provenance on the revision, nothing more. */
  branch?: string;
  /** base64 of the repo archive — a zip, or a gzipped tar from an older CLI. */
  archive?: string;
  /** Create any dataset the repo publishes that does not exist here yet. */
  createDatasets?: boolean;
  /** Name the repo explicitly. Optional; nothing sends it yet. */
  repoSlug?: string;
  git?: { sha?: string | null; branch?: string | null; dirty?: boolean | null };
  /**
   * Store the archive as a BRANCH PREVIEW of `branch` instead of publishing it
   * (src/lib/repo-previews.ts): compiled, addressable as `repo@branch:dataset`,
   * and live for nobody. `malloyyo publish --branch` sends it. Admin-only.
   */
  preview?: boolean;
};

export async function POST(req: Request) {
  const auth = await requireBearer(req, { scope: "publish" });
  if (!auth.ok) return bad(auth.error, auth.status);

  const body = (await req.json().catch(() => null)) as Body | null;
  const githubRepo = typeof body?.repo === "string" ? body.repo.trim() : "";
  const branch = (typeof body?.branch === "string" && body.branch.trim()) || "main";
  if (!githubRepo && !body?.repoSlug) return bad("repo is required (e.g. --repo owner/name)", 400);
  if (typeof body?.archive !== "string" || !body.archive) return bad("no archive in payload", 400);

  // The client's provenance claim, kept only when it is shaped like one: a
  // full commit SHA. Nothing downstream may treat it as verified.
  if (body.git && (typeof body.git.sha !== "string" || !/^[0-9a-f]{40}$/i.test(body.git.sha))) {
    body.git = { ...body.git, sha: null };
  }
  const raw = Buffer.from(body.archive, "base64");
  if (raw.length === 0) return bad("the repo archive is empty", 400);

  const found = await findRepoForPublish({ githubRepo, repoSlug: body.repoSlug });
  if ("error" in found) return bad(found.error, 409, { kind: "request" });

  if (body.preview) {
    // Admin-only to start, like every other way in to a preview. A preview of
    // a repo that doesn't exist here has nothing to be a preview OF.
    if (!isAdmin(auth.user)) return bad("Branch previews are for admins.", 403, { kind: "request" });
    if (!("repo" in found)) {
      return bad(`"${githubRepo || body.repoSlug}" is not a repo on this instance — publish it before previewing a branch`, 404, {
        kind: "request",
      });
    }
    const previewBranch = (typeof body.git?.branch === "string" && body.git.branch.trim()) || branch;
    try {
      const result = await storePreview(found.repo, raw, {
        source: "cli",
        branch: previewBranch,
        sha: body.git?.sha ?? null,
        // A preview upload is a working tree: dirty unless the client says clean.
        dirty: body.git?.dirty ?? true,
        createdById: auth.user.id,
      });
      if (!result.ok) return bad(result.error, 400, { kind: "compile" });
      logger.info("repo branch preview stored", {
        repo: found.repo.slug,
        branch: result.branch,
        revision: result.revision,
        credential: credentialLabel(auth.cred),
      });
      return NextResponse.json(result);
    } catch (err) {
      logger.error("repo branch preview failed", { repo: found.repo.slug, ...serializeErr(err) });
      return bad("the preview could not be stored — the server log has the detail", 500, { kind: "persist" });
    }
  }

  let repo;
  if ("repo" in found) {
    repo = found.repo;
    // WHO MAY PUBLISH TO A REPO: its owner, or an admin. The first
    // implementation of this route shipped with no gate at all, because a repo
    // had no owner to check — so any member holding a publish token could
    // overwrite anyone's datasets. That is not defacement, it is code
    // execution: the archive carries the repo's `malloy-config.json`, whose
    // connection secrets are `{"env": …}` references resolved against THIS
    // server's environment, and compiling resolves schemas by running SQL.
    if (repo.ownerId !== auth.user.id && !isAdmin(auth.user)) {
      return bad(
        `that account doesn't own the repo "${repo.slug}" and isn't an admin on this instance — ` +
          `publishing is limited to a repo's owner`,
        403,
        { kind: "request" },
      );
    }
  } else {
    // Creating a repo names a codebase this server will compile, which is the
    // same reach `POST /api/datasets` is admin-only for.
    if (!canAuthor(auth.user)) {
      return bad(
        `"${githubRepo}" is not a repo on this instance yet, and creating one is admin-only — ` +
          `ask an admin to add it`,
        403,
        { kind: "request" },
      );
    }
    const slug = body.repoSlug ? nameToSlug(body.repoSlug) : repoSlugFromGitHub(githubRepo);
    if (!slug) return bad(`could not make a repo name out of "${githubRepo}"`, 400, { kind: "request" });
    try {
      [repo] = await db
        .insert(repos)
        .values({
          slug,
          ownerId: auth.user.id,
          // NOT ATTACHED TO GITHUB. The CLI sent a GitHub slug to say which
          // repo this is, not to ask for a GitHub pull. The previous
          // implementation could not tell those apart — one pair of columns
          // meant both — so a CLI publish stamped the author's LOCAL branch
          // onto every dataset it created, and the refresh button would then
          // pull `github.com/<slug>@wip` over the top of what had just been
          // pushed. Attaching is a separate, deliberate act.
          githubRepo: null,
          githubBranch: null,
          githubUseToken: false,
        })
        .returning();
    } catch (err) {
      // Two publishes racing to create the same repo. The loser reports the
      // right outcome instead of a database error.
      logger.info("repo create raced", { slug, ...serializeErr(err) });
      return bad(
        `another publish created the repo "${slug}" first — run the publish again`,
        409,
        { kind: "request" },
      );
    }
  }

  try {
    const result = await publishRevision({
      repo,
      raw,
      source: "cli",
      createdById: auth.user.id,
      git: { sha: body.git?.sha ?? null, branch: body.git?.branch ?? branch, dirty: body.git?.dirty ?? null },
      createDatasets: body.createDatasets ?? false,
      // A dataset this publish creates belongs to the person who published it,
      // not to whoever happens to own the repo — a repo's owner may be an admin
      // who added it, and the publisher is who will maintain the dataset.
      datasetOwnerId: auth.user.id,
      // `--repo` is the multi-dataset flag; a root `index.malloy` is
      // `--dataset <name>`'s business, and the refusal names it.
      refuseRootLayout: true,
      // Someone is reading an exit code: name the flag rather than publishing
      // what happens to be covered and leaving a directory behind silently.
      onMissing: "refuse",
    });

    if (!result.ok) {
      logger.info("repo push refused", {
        repo: repo.slug,
        credential: credentialLabel(auth.cred),
        kind: result.kind,
        revisionId: result.revisionId,
        error: result.error,
      });
      void captureTelemetry({
        event: "model published",
        properties: {
          method: "cli_repo_push",
          outcome: "error",
          created_dataset: false,
          source_count: 0,
          file_count: 0,
          dashboard_count: 0,
        },
      });
      const status =
        result.kind === "request"
          ? 404
          : result.kind === "stale" || result.kind === "clash"
            ? 409
            : 400;
      return bad(
        result.kind === "compile" ? `nothing was published — ${result.error}` : result.error,
        status,
        {
          kind:
            result.kind === "layout" || result.kind === "archive"
              ? "compile"
              : result.kind === "clash"
                ? "request"
                : result.kind,
          ...(result.failures
            ? { failures: result.failures.map((f) => ({ name: f.name, error: f.error })) }
            : {}),
          ...(result.missing ? { missing: result.missing.map((m) => m.name) } : {}),
        },
      );
    }

    void captureTelemetry({
      event: "model published",
      properties: {
        method: "cli_repo_push",
        outcome: "success",
        created_dataset: result.datasets.some((d) => d.created),
        source_count: 0,
        file_count: 0,
        dashboard_count: 0,
      },
    });
    logger.info("repo published", {
      repo: repo.slug,
      revision: result.revision,
      unchanged: result.unchanged ?? false,
      credential: credentialLabel(auth.cred),
      datasets: result.datasets.map((d) => d.qualified),
    });

    return NextResponse.json({
      ok: true,
      // The field the CLI prints, unchanged in meaning: what the caller named.
      repo: githubRepo || repo.slug,
      branch,
      revision: result.revision,
      datasets: result.datasets.map((d) => ({
        name: d.name,
        // Additive: the new public identity, for a CLI that wants to print it.
        qualified: d.qualified,
        version: d.version,
        created: d.created,
      })),
      ...(result.unclaimed.length > 0 ? { unclaimed: result.unclaimed.map((u) => u.name) } : {}),
    });
  } catch (err) {
    // Nothing partial survives a throw: the revision is stored and inert, and
    // the activation is one transaction. There is nothing to clean up.
    logger.error("repo push failed", { repo: repo.slug, ...serializeErr(err) });
    return bad("the publish could not be completed — the server log has the detail", 500, {
      kind: "persist",
    });
  }
}
