// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/oauth/base-url";
import { corsPreflight, withCors } from "@/lib/oauth/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = originFromRequest(request);
  return withCors(NextResponse.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  }));
}

export async function OPTIONS() {
  return corsPreflight();
}
