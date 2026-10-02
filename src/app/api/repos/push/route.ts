// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/repos/push` — publish a whole repo.
 *
 * The repo is the unit of publish, so it is also the unit of transfer: the CLI
 * packs the repo into the same archive GitHub hands us for a repo we pull, and
 * both arrive at one extractor and one compile-all-then-write-all
 * (src/lib/github-refresh.ts). Every dataset the repo publishes lands together
 * or none of them does.
 *
 * The single-dataset path is untouched. `malloyyo publish --dataset x` still
 * posts to /api/datasets/x/model/push and still means one dataset, because every
 * repo that exists today is that shape and the flag has to keep meaning what it
 * meant.
 */

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, datasets } from "@/db";
import { credentialLabel, requireBearer } from "@/lib/bearer-auth";
import { canAuthor } from "@/lib/roles";
import { isAdmin } from "@/lib/admin";
import { compileAndWrite, contextFromArchive } from "@/lib/github-refresh";
import { extractTarGz, archiveLister } from "@/lib/tarball";
import { layoutFromListing } from "@/lib/repo-layout";
import { logger, serializeErr } from "@/lib/logger";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const bad = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status });

type Body = {
  /** Identifies the SET of datasets this repo backs, e.g. "owner/name". */
  repo?: string;
  branch?: string;
  /** base64 of a gzipped tar of the repo, repo-relative. */
  archive?: string;
  /** Create any dataset the repo publishes that does not exist yet. */
  createDatasets?: boolean;
  git?: { sha?: string | null; branch?: string | null; dirty?: boolean | null };
};

export async function POST(req: Request) {
  const auth = await requireBearer(req, { scope: "publish" });
  if (!auth.ok) return bad(auth.error, auth.status);

  const body = (await req.json().catch(() => null)) as Body | null;
  const repoSlug = typeof body?.repo === "string" ? body.repo.trim() : "";
  const branch = (typeof body?.branch === "string" && body.branch.trim()) || "main";
  if (!repoSlug) return bad("repo is required (e.g. --repo owner/name)", 400);
  if (typeof body?.archive !== "string" || !body.archive) return bad("no archive in payload", 400);

  let files: Map<string, string>;
  try {
    const extracted = extractTarGz(Buffer.from(body.archive, "base64"));
    files = extracted.files;
  } catch (err) {
    return bad(`could not read the repo archive: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  if (files.size === 0) return bad("the repo archive contains no model files", 400);

  // The same rules the server applies to a repo it pulls, over the archive.
  const layout = await layoutFromListing(archiveLister(files), repoSlug);
  if (!layout.ok) return bad(layout.error, 400, { kind: "compile" });

  const publishes =
    layout.kind === "single"
      ? [{ name: "", dir: null as string | null }]
      : layout.datasets.map((d) => ({ name: d.name, dir: d.dir as string | null }));

  // A single-dataset repo has no directory to name it, and this endpoint has no
  // --dataset. Point the caller at the flag that does.
  if (layout.kind === "single") {
    return bad(
      `${repoSlug} publishes a single dataset (index.malloy at its root), so it has no name of its own here. ` +
        `Publish it with --dataset <name> instead.`,
      400,
      { kind: "request" },
    );
  }

  const existing = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.githubRepo, repoSlug), eq(datasets.githubBranch, branch)));
  const byDir = new Map(existing.map((d) => [d.repoDir ?? null, d]));

  // WHO MAY WRITE TO AN EXISTING DATASET: its owner, or an admin. The same gate
  // /api/datasets/[id]/model/push has had all along — this route is a second
  // publish path and shipped without it, so any member holding a publish token
  // could overwrite a dataset they do not own.
  //
  // That is not defacement, it is code execution: the archive carries the repo's
  // `malloy-config.json`, whose connection secrets are `{"env": …}` refs resolved
  // against THIS SERVER's environment, and compiling resolves schemas by running
  // SQL. It is the precise reach that got MALLOYYO_DEVELOPER deleted
  // (src/lib/roles.ts).
  const mine = (d: (typeof existing)[number]) => d.userId === auth.user.id;
  const foreign = existing.filter(
    (d) => publishes.some((p) => p.dir === (d.repoDir ?? null)) && !mine(d),
  );
  if (foreign.length > 0 && !isAdmin(auth.user)) {
    return bad(
      `that account doesn't own ${foreign.map((d) => `"${d.name}"`).join(", ")} and isn't an ` +
        `admin on this instance — publishing is limited to a dataset's owner`,
      403,
      { kind: "request" },
    );
  }

  const missing = publishes.filter((p) => !byDir.has(p.dir));
  if (missing.length > 0 && !body.createDatasets) {
    return bad(
      `${missing.map((m) => m.name).join(", ")}: not on this instance yet. ` +
        `Pass --create-datasets to create ${missing.length > 1 ? "them" : "it"}.`,
      404,
      { kind: "no-dataset", missing: missing.map((m) => m.name) },
    );
  }
  if (missing.length > 0 && !canAuthor(auth.user)) {
    return bad("creating a dataset is admin-only — ask an admin to create it", 403, { kind: "request" });
  }

  // Names are URLs: check every one BEFORE writing any, so a repo cannot
  // half-land because its third directory collided.
  if (missing.length > 0) {
    const names = missing.map((m) => m.name);
    const clashes = await db
      .select({ name: datasets.name })
      .from(datasets)
      .where(and(inArray(datasets.name, names), eq(datasets.status, "ready")));
    if (clashes.length > 0) {
      return bad(
        `already on this instance under a different repo: ${clashes.map((c) => c.name).join(", ")}`,
        409,
        { kind: "request" },
      );
    }
  }

  const createdIds: string[] = [];
  try {
    for (const m of missing) {
      const id = crypto.randomUUID();
      await db.insert(datasets).values({
        id,
        userId: auth.user.id,
        name: m.name,
        githubRepo: repoSlug,
        githubBranch: branch,
        // Nothing here pulls from GitHub — the archive came with the request —
        // so a token would never be used and claiming otherwise would be a lie
        // the config UI then shows.
        githubUseToken: false,
        repoDir: m.dir,
        // Private by default: visibility is a deliberate act in the UI, never
        // config-driven, and publish never changes it.
        isPublic: false,
        status: "ready",
        readyAt: new Date(),
      });
      createdIds.push(id);
    }

    const targets = [...existing.filter((d) => publishes.some((p) => p.dir === (d.repoDir ?? null)))];
    if (createdIds.length > 0) {
      targets.push(...(await db.select().from(datasets).where(inArray(datasets.id, createdIds))));
    }

    const ctx = contextFromArchive(files, {
      slug: repoSlug,
      branch,
      sha: body.git?.sha ?? null,
      origin: `cli:${repoSlug}@${branch}`,
    });

    // ONE call, so ONE transaction. `creating` rides on each target — it applies
    // only to the rows this request made, because a dataset already here is the
    // authority on what it is scoped by and a publish may not widen it
    // (src/lib/tenancy.ts). Two calls would have been two transactions, and a
    // repo that creates one dataset while refreshing another would half-land.
    const fresh = new Set(createdIds);
    const { refreshed, failed: allFailed } = await compileAndWrite(
      targets.map((t) => ({ ...t, creating: fresh.has(t.id) })),
      ctx,
    );

    if (allFailed.length > 0) {
      // Nothing was written for any dataset — including the rows just inserted,
      // which are removed so the instance is exactly as it started.
      if (createdIds.length > 0) {
        await db.delete(datasets).where(inArray(datasets.id, createdIds));
      }
      logger.info("repo push refused", {
        repo: repoSlug,
        branch,
        credential: credentialLabel(auth.cred),
        failed: allFailed,
      });
      return bad(
        `nothing was published — ${allFailed.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
        400,
        { kind: "compile", failures: allFailed },
      );
    }

    const published = refreshed;
    void captureTelemetry({
      event: "model published",
      properties: {
        method: "cli_repo_push",
        outcome: "success",
        created_dataset: createdIds.length > 0,
        source_count: 0,
        file_count: files.size,
        dashboard_count: 0,
      },
    });
    logger.info("repo published", {
      repo: repoSlug,
      branch,
      credential: credentialLabel(auth.cred),
      datasets: published.map((p) => p.name),
      created: createdIds.length,
    });
    return NextResponse.json({
      ok: true,
      repo: repoSlug,
      branch,
      datasets: published.map((p) => ({
        name: p.name,
        version: p.version,
        created: fresh.has(p.id),
      })),
    });
  } catch (err) {
    if (createdIds.length > 0) {
      await db.delete(datasets).where(inArray(datasets.id, createdIds)).catch(() => {});
    }
    // The message stays in the log: this route is reachable by any member with a
    // publish token, and a raw database error is not theirs to read.
    logger.error("repo push failed", { repo: repoSlug, ...serializeErr(err) });
    return bad("the publish could not be completed — the server log has the detail", 500, {
      kind: "persist",
    });
  }
}
