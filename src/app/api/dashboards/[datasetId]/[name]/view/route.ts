// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// JSON view data (info + given specs) for a TAG-ONLY dashboard rendered in-page
// (TagOnlyDashboard). This lives in an API route — NOT the page — on purpose:
// assembling it introspects the model's given: declarations via Malloy, which
// pulls in @duckdb/node-api (libduckdb.so). A Next PAGE render function can't
// load that native lib and 500s (reference_ssr_page_duckdb_500 / PR #80), but an
// API route bundles it. The page only reads Postgres to branch custom vs
// tag-only; the tag-only client fetches this. The sandboxed-iframe (custom) path
// gets the same data as HTML from the sibling /frame route.

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { dashboardViewData } from "@/lib/dashboards/engine";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  try {
    const user = await getSessionUser();
    const { datasetId, name } = await ctx.params;
    const view = await dashboardViewData(user.id, datasetId, name);
    if (!view) return NextResponse.json({ ok: false, error: "dashboard not found" }, { status: 404 });
    return NextResponse.json({ ok: true, info: view.info, givenSpecs: view.givenSpecs });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
    }
    throw err;
  }
}
