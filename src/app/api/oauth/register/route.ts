// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { db, oauthClients } from "@/db";
import { corsPreflight, withCors } from "@/lib/oauth/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

function err(error: string, description: string, status = 400): Response {
  return withCors(NextResponse.json({ error, error_description: description }, { status }));
}

function isAllowedRedirect(uri: string): boolean {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return false; }
  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return false;
}

export async function OPTIONS() { return corsPreflight(); }

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return err("invalid_client_metadata", "Request body must be valid JSON"); }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0)
    return err("invalid_redirect_uri", "redirect_uris must be a non-empty array");

  const redirectUris: string[] = [];
  for (const uri of body.redirect_uris) {
    if (typeof uri !== "string" || !isAllowedRedirect(uri))
      return err("invalid_redirect_uri", "Each redirect_uri must be HTTPS (or http://localhost) with no fragment");
    redirectUris.push(uri);
  }

  const tokenEndpointAuthMethod = body.token_endpoint_auth_method == null ? "none" : String(body.token_endpoint_auth_method);
  if (tokenEndpointAuthMethod !== "none")
    return err("invalid_client_metadata", 'Only public clients (token_endpoint_auth_method="none") are supported');

  const grantTypes: string[] = Array.isArray(body.grant_types)
    ? body.grant_types.filter((g): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  for (const g of grantTypes)
    if (!ALLOWED_GRANT_TYPES.has(g)) return err("invalid_client_metadata", `Unsupported grant_type: ${g}`);

  const responseTypes: string[] = Array.isArray(body.response_types)
    ? body.response_types.filter((t): t is string => typeof t === "string")
    : ["code"];
  if (responseTypes.some((t) => t !== "code"))
    return err("invalid_client_metadata", 'Only response_type="code" is supported');

  const requestedScope = typeof body.scope === "string" ? body.scope.trim() : "";
  if (requestedScope && requestedScope !== "mcp")
    return err("invalid_client_metadata", 'Only "mcp" scope is supported');

  const name = (typeof body.client_name === "string" ? body.client_name.trim() : "Unnamed MCP client").slice(0, 100);
  const registeredFromIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("x-real-ip") ?? null;

  const [client] = await db.insert(oauthClients).values({
    name, redirectUris, tokenEndpointAuthMethod: "none", grantTypes, responseTypes, scope: "mcp", registeredFromIp,
  }).returning();

  return withCors(NextResponse.json({
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
  }, { status: 201 }));
}
