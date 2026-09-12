// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/oauth/base-url";
import { corsPreflight, withCors } from "@/lib/oauth/cors";
import { API_TOKEN_SCOPES } from "@/lib/api-token-scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = originFromRequest(request);
  return withCors(NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    // Everything the authorize endpoint will grant. Derived, so adding a scope
    // cannot leave the metadata claiming it is unsupported. The MCP resource's
    // own metadata still advertises "mcp" alone — that is all an MCP client
    // needs to ask for, and it is why a claude.ai connection cannot publish.
    scopes_supported: [...API_TOKEN_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  }));
}

export async function OPTIONS() {
  return corsPreflight();
}
