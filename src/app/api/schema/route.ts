// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { findBySource, modelFileMap } from "@/lib/mcp-tools";
import { describeSourceFields } from "@/lib/malloy";

export const runtime = "nodejs";

// The web dataset-page schema viewer. This is a SEPARATE consumer from the MCP
// explore surface (which now runs on the engine): the UI wants the flat field
// tree (describeSourceFields), not the engine's describe shape. Same JSON the
// old callTool("describe_source") returned, so the React view is unchanged.
export async function GET(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const source = new URL(req.url).searchParams.get("source");
  if (!source) return NextResponse.json({ error: "source is required" }, { status: 400 });

  const found = await findBySource(user.id, source);
  if (!found) return NextResponse.json({ error: `source '${source}' not found` }, { status: 404 });

  const { ds, model, description } = found;
  const files = await modelFileMap(model);
  const fields = await describeSourceFields(files, "index.malloy", source, { cacheKey: model.id });
  return NextResponse.json({ source, model: ds.name, description, fields, malloy_source: model.source });
}
