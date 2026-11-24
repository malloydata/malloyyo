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
import { and, eq, isNull } from "drizzle-orm";
import { nameToSlug } from "@malloyyo/mcp-engine";
import { datasetAliases, datasets, db, repos, type Dataset } from "@/db";
import { env } from "@/lib/env";
import { credentialLabel, requireBearer } from "@/lib/bearer-auth";
import { logger, serializeErr } from "@/lib/logger";
import { storePreview } from "@/lib/repo-preview-store";
import { publishRevision } from "@/lib/repo-publish";
import { findRepoForPublish, qualifiedName, repoSlugFromGitHub, resolveDatasetRef } from "@/lib/repos";
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
  /**
   * The name of a SINGLE-dataset repo's one dataset (a root `index.malloy`, which
   * has no directory to be named after). Optional and additive: the CLI sends the
   * config target's `dataset`. A repo-less dataset of that name — one an older
   * `malloyyo publish --dataset` pushed — is ADOPTED into the repo rather than
   * shadowed by a new one (see `adoptRoot` in src/lib/repo-publish.ts).
   */
  dataset?: string;
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

  // PUBLISHING IS FOR ADMINS. Every way in — a publish, a branch preview,
  // creating a repo or a dataset — runs a repo's model on this server: the
  // archive's malloy-config.json names `{"env": …}` secrets resolved against
  // THIS server's environment, and compiling runs SQL to resolve schemas. So
  // there is one gate, the role, and no ownership exceptions beside it.
  if (!canAuthor(auth.user)) {
    return bad("publishing is admin-only on this instance — ask an admin to publish", 403, {
      kind: "request",
    });
  }

  const found = await findRepoForPublish({ githubRepo, repoSlug: body.repoSlug });
  if ("error" in found) return bad(found.error, 409, { kind: "request" });

  if (body.preview) {
    // A preview of a repo that doesn't exist here has nothing to be a preview OF.
    if (!env.REPO_AUTHORING) return bad(`Repo authoring is off on this instance (REPO_AUTHORING). An operator turns it on.`, 403, { kind: "request" });
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

  // WHAT THE ROOT DATASET IS. Decided before anything is written, so a refusal
  // here leaves no repo row behind.
  const root = typeof body.dataset === "string" && body.dataset.trim() ? await rootDataset(body.dataset.trim(), found) : { ok: true as const };
  if (!root.ok) return bad(root.error, root.status, { kind: "request" });

  let repo;
  if ("repo" in found) {
    repo = found.repo;
  } else {
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
  const rootName = root.name;
  const adoptRoot = root.adopt;

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
      // A root `index.malloy` publishes like any other repo now: named by
      // `dataset` when the caller sent one, else after the repo.
      ...(rootName ? { rootDatasetName: rootName } : {}),
      ...(adoptRoot ? { adoptRoot } : {}),
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
      // A compile failure that is really a connection the server cannot open —
      // usually a secret set on the author's machine and not on this one. The
      // CLI names the variable when `kind` says so (its `failureHint`).
      //
      // EVERY failure has to look like one: in a repo where one dataset cannot
      // connect and another has a typo, connection advice is wrong for half of it.
      const connectionLike = (e: string) =>
        /No connection named|Invalid SQL, (connect |getaddrinfo|Error: connect)/i.test(e) ||
        ((result.missingEnv?.length ?? 0) > 0 && /connect|authentication|password/i.test(e));
      const failureErrors = result.failures?.length ? result.failures.map((f) => f.error) : [result.error];
      const connection = result.kind === "compile" && failureErrors.every(connectionLike);
      return bad(
        result.kind === "compile" ? `nothing was published — ${result.error}` : result.error,
        status,
        {
          ...(connection ? { missingEnv: result.missingEnv ?? [] } : {}),
          kind: connection
            ? "connection"
            : result.kind === "layout" || result.kind === "archive"
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
      // Additive: these exact bytes were already live, so no version was written
      // (each dataset's `version` is 0).
      ...(result.unchanged ? { unchanged: true } : {}),
      datasets: result.datasets.map((d) => ({
        name: d.name,
        // Additive: the new public identity, for a CLI that wants to print it.
        qualified: d.qualified,
        version: d.version,
        created: d.created,
        ...(d.adopted ? { adopted: true } : {}),
        ...(d.declaredButUnused ? { declaredButUnused: d.declaredButUnused } : {}),
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the CLI's `dataset` (a single-dataset repo's target) names, against the
 * repo being published.
 *
 * - The repo HAS a root dataset: `dataset` must name that one — its name, id,
 *   qualified name, or an alias of it. Anything else is refused. Silently
 *   publishing over the root would overwrite one dataset with a working tree
 *   meant for another: two targets on one instance (`prod → mdw`,
 *   `dev → mdw_dev`) are two datasets, and so are two projects whose repos share
 *   a leaf name.
 * - The repo has NO root dataset yet: a uuid or `repo:name` must name an
 *   existing REPO-LESS dataset, which is adopted. A bare name adopts the
 *   repo-less dataset of that name if there is one, and otherwise is the name a
 *   new dataset would be created under — the only case the slug rule applies.
 */
async function rootDataset(
  ref: string,
  found: Awaited<ReturnType<typeof findRepoForPublish>>,
): Promise<
  | { ok: true; name?: string; adopt?: Dataset }
  | { ok: false; status: number; error: string }
> {
  const repo = "repo" in found ? found.repo : null;
  const [current] = repo
    ? await db
        .select()
        .from(datasets)
        .where(and(eq(datasets.repoId, repo.id), eq(datasets.repoDir, ""), eq(datasets.status, "ready")))
        .limit(1)
    : [];

  if (current) {
    const [alias] = await db
      .select({ id: datasetAliases.datasetId })
      .from(datasetAliases)
      .where(and(eq(datasetAliases.alias, ref), eq(datasetAliases.datasetId, current.id)))
      .limit(1);
    const names = [current.name, current.id, qualifiedName(repo!.slug, current.name)];
    if (names.includes(ref) || alias) return { ok: true, name: current.name };
    return {
      ok: false,
      status: 409,
      error:
        `the repo "${repo!.slug}" publishes dataset "${current.name}" from its root, but this publish ` +
        `targets "${ref}". Nothing was published — a single-dataset repo publishes one dataset. ` +
        `Target "${current.name}", or publish "${ref}" from its own repo (--repo <owner/name>).`,
    };
  }

  if (UUID_RE.test(ref) || ref.includes(":")) {
    const r = await resolveDatasetRef(ref);
    if (!r.ok) return { ok: false, status: 404, error: `the target's dataset "${ref}": ${r.error}` };
    if (r.dataset.repoId !== null) {
      return {
        ok: false,
        status: 409,
        error:
          `the target's dataset "${ref}" is "${r.dataset.name}" of the repo "${r.repo?.slug ?? "?"}", ` +
          `so it can't be published from this one`,
      };
    }
    return { ok: true, name: r.dataset.name, adopt: r.dataset };
  }

  const [orphan] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.name, ref), isNull(datasets.repoId), eq(datasets.status, "ready")))
    .limit(1);
  if (orphan) return { ok: true, name: orphan.name, adopt: orphan };

  // Creating: the name has to resolve to itself on every later publish, so it
  // is never quietly slugified into something else.
  if (nameToSlug(ref) !== ref) {
    return {
      ok: false,
      status: 400,
      error:
        `"${ref}" is not a usable dataset name: dataset names are lowercase letters, digits ` +
        `and underscores — use "${nameToSlug(ref)}"`,
    };
  }
  return { ok: true, name: ref };
}
