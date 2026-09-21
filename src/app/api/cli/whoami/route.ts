// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/bearer-auth";
import { originFromRequest } from "@/lib/oauth/base-url";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * GET /api/cli/whoami — who a bearer token belongs to, HERE.
 *
 * The CLI calls this before storing a pasted token (`malloyyo login <url>
 * --token-stdin`), so a token issued by one instance is rejected at login
 * rather than on the first real command against another. The URL is what
 * tells instances apart — a local dev server can share an INSTANCE_CODE with
 * production, so the token's prefix can't. Not a use of the token.
 */
export async function GET(req: Request) {
  const auth = await requireBearer(req, { scope: "mcp", recordUse: false });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  return NextResponse.json({
    ok: true,
    email: auth.user.email,
    instance: env.INSTANCE_NAME,
    url: originFromRequest(req),
    scopes: auth.cred.scopes,
    expiresAt: auth.cred.kind === "api-token" ? auth.cred.token.expiresAt : null,
  });
}
