// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { consumeAuthorizationCode, verifyPkce } from "@/lib/oauth/codes";
import { getOAuthClient } from "@/lib/oauth/clients";
import { issueTokenPair, rotateRefreshToken } from "@/lib/oauth/tokens";
import { corsPreflight, withCors } from "@/lib/oauth/cors";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TokenRequest {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  refresh_token?: string;
  resource?: string;
}

function err(error: string, description: string, status = 400): Response {
  return withCors(NextResponse.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }));
}

function tokenResponse(accessToken: string, refreshToken: string, expiresIn: number, scope: string): Response {
  return withCors(NextResponse.json(
    { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope },
    { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  ));
}

export async function OPTIONS() { return corsPreflight(); }

async function readRequest(request: Request): Promise<TokenRequest | null> {
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      const out: Record<string, string> = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
      return out;
    }
    const text = await request.text();
    try { return JSON.parse(text); } catch {
      const params = new URLSearchParams(text);
      const out: Record<string, string> = {};
      for (const [k, v] of params.entries()) out[k] = v;
      return out;
    }
  } catch { return null; }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readRequest(request);
  if (!body) return err("invalid_request", "Could not parse request body");
  if (body.grant_type === "authorization_code") return handleAuthorizationCode(body);
  if (body.grant_type === "refresh_token") return handleRefreshToken(body);
  return err("unsupported_grant_type", `grant_type "${body.grant_type ?? ""}" is not supported`);
}

async function handleAuthorizationCode(body: TokenRequest): Promise<Response> {
  const { code, redirect_uri, client_id, code_verifier } = body;
  if (!code || !redirect_uri || !client_id || !code_verifier)
    return err("invalid_request", "code, redirect_uri, client_id, and code_verifier are required");

  const client = await getOAuthClient(client_id);
  if (!client) return err("invalid_client", "Unknown client_id");

  const consumed = await consumeAuthorizationCode(code);
  if (!consumed.ok) return err("invalid_grant", `Authorization code ${consumed.reason}`);

  const row = consumed.row;
  if (row.clientId !== client_id) return err("invalid_grant", "Authorization code was not issued to this client");
  if (row.redirectUri !== redirect_uri) return err("invalid_grant", "redirect_uri does not match");
  if (!verifyPkce(row.codeChallenge, row.codeChallengeMethod, code_verifier)) return err("invalid_grant", "PKCE verification failed");

  const tokens = await issueTokenPair({ clientId: row.clientId, userId: row.userId, scope: row.scope, resource: row.resource });
  return tokenResponse(tokens.accessToken, tokens.refreshToken, tokens.expiresIn, row.scope);
}

async function handleRefreshToken(body: TokenRequest): Promise<Response> {
  const { refresh_token, client_id } = body;
  if (!refresh_token || !client_id) return err("invalid_request", "refresh_token and client_id are required");

  const client = await getOAuthClient(client_id);
  if (!client) return err("invalid_client", "Unknown client_id");

  const result = await rotateRefreshToken(refresh_token, client_id);
  if (!result.ok) {
    if (result.reason === "replayed") logger.warn("oauth token replay detected; grant revoked", { clientId: client_id });
    return err("invalid_grant", `Refresh token ${result.reason}`);
  }
  return tokenResponse(result.tokens.accessToken, result.tokens.refreshToken, result.tokens.expiresIn, "mcp");
}
