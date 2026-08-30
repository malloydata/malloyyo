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
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db, history, savedQueries } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { findByDatasetRef, normalizeSources } from "@/lib/mcp-tools";
import { listDashboards } from "@/lib/dashboards/meta";
import { datasetLandingPath } from "@/lib/dataset-landing";
import { signInPath } from "@/lib/auth-paths";
import { RUN_LABELS } from "@/lib/tool-names";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Will the Q&A page have anything to show?
 *
 * The predicate has to match what `datasetQuestions` (api/history) actually
 * LISTS, not merely what exists. A looser test sends the reader to a page that
 * says "no questions" — the dead end this whole chain exists to avoid — and it
 * is easy to be looser by accident: a failed MCP `query` still records a history
 * row carrying a question, with an error and no slug, and the Q&A page correctly
 * ignores it.
 *
 * So the history side mirrors that filter exactly: an executed run, no error,
 * and a slug (the page links each question to its shared answer, so a row
 * without one cannot be rendered).
 *
 * EXISTS rather than a count — the answer is a boolean and these tables grow.
 */
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
    .where(
      and(
        eq(history.datasetId, datasetId),
        inArray(history.toolName, RUN_LABELS),
        eq(history.executed, true),
        isNull(history.error),
        isNotNull(history.slug),
      ),
    )
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
