// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// `/datasets/<ref>` — the dataset's front door. It renders nothing: it decides
// where a reader should land and redirects there. The chain, and why it is in
// this order, lives in @/lib/dataset-landing.
//
// This route used to BE the config page (model version, files, GitHub settings).
// That is the operator's view, and it was what every dataset link led to; it now
// lives at /datasets/<ref>/config and the nav's "config" item points there.
//
// A server component, so the redirect happens before anything renders — no
// flash of a page the reader did not ask for. It must stay DuckDB-free like
// every page: @/lib/dashboards/meta is the DB-only module, and the counts below
// are plain drizzle. Do NOT reach into @/lib/dashboards/engine or @/lib/malloy
// from here (check-page-no-duckdb fails the build if you do).

import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db, history, savedQueries } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { findByDatasetRef, normalizeSources } from "@/lib/mcp-tools";
import { listDashboards } from "@/lib/dashboards/meta";
import { datasetLandingPath } from "@/lib/dataset-landing";
import { signInPath } from "@/lib/auth-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Has anyone asked anything of this dataset? Either store counts — a saved
    query is a question someone kept, a history row is one that was answered.
    EXISTS rather than a count: the answer is a boolean and these tables grow. */
async function hasQuestions(datasetId: string): Promise<boolean> {
  const [saved] = await db
    .select({ n: sql<number>`1` })
    .from(savedQueries)
    .where(eq(savedQueries.datasetId, datasetId))
    .limit(1);
  if (saved) return true;
  const [asked] = await db
    .select({ n: sql<number>`1` })
    .from(history)
    .where(and(eq(history.datasetId, datasetId), sql`${history.question} is not null`))
    .limit(1);
  return Boolean(asked);
}

export default async function DatasetLandingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: ref } = await params;

  let userId: string;
  try {
    userId = (await getSessionUser()).id;
  } catch (err) {
    // The middleware already redirects unauthenticated page navigations, so this
    // is the belt-and-braces path (a stale session racing the render).
    if (err instanceof UnauthorizedError) redirect(signInPath(`/datasets/${encodeURIComponent(ref)}`));
    throw err;
  }

  const found = await findByDatasetRef(userId, ref);
  // Not visible, or has no model yet: config is the only page that can say
  // something useful about a dataset in that state, so send them there rather
  // than to a dashboard list that would be empty for a reason we can't explain.
  if (!found) redirect(`/datasets/${encodeURIComponent(ref)}/config`);

  const [dashboards, questions] = await Promise.all([
    listDashboards(userId, ref),
    hasQuestions(found.ds.id),
  ]);

  redirect(
    datasetLandingPath(ref, {
      dashboards,
      hasQuestions: questions,
      firstSource: normalizeSources(found.model.sources)[0]?.name ?? null,
    }),
  );
}
