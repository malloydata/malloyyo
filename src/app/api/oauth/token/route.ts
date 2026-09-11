// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { consumeAuthorizationCode, verifyPkce } from "@/lib/oauth/codes";
import { clientMayUse, getOAuthClient } from "@/lib/oauth/clients";
import type { OAuthClient } from "@/db";
import { issueTokenPair, rotateRefreshToken } from "@/lib/oauth/tokens";
import { pollDeviceCode, DEVICE_GRANT_TYPE } from "@/lib/oauth/device-codes";
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
  device_code?: string;
  resource?: string;
}

function err(error: string, description: string, status = 400): Response {
  return withCors(NextResponse.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }));
}

/** The client, or the RFC 6749 §5.2 error for it: unknown, or registered for
    some other grant than the one it is asking for. */
async function clientFor(clientId: string, grantType: string): Promise<OAuthClient | Response> {
  const client = await getOAuthClient(clientId);
  if (!client) return err("invalid_client", "Unknown client_id");
  if (!clientMayUse(client, grantType))
    return err("unauthorized_client", `Client is not registered for the ${grantType} grant`);
  return client;
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
  if (body.grant_type === DEVICE_GRANT_TYPE) return handleDeviceCode(body);
  return err("unsupported_grant_type", `grant_type "${body.grant_type ?? ""}" is not supported`);
}

async function handleAuthorizationCode(body: TokenRequest): Promise<Response> {
  const { code, redirect_uri, client_id, code_verifier } = body;
  if (!code || !redirect_uri || !client_id || !code_verifier)
    return err("invalid_request", "code, redirect_uri, client_id, and code_verifier are required");

  const client = await clientFor(client_id, "authorization_code");
  if (client instanceof Response) return client;

  const consumed = await consumeAuthorizationCode(code);
  if (!consumed.ok) return err("invalid_grant", `Authorization code ${consumed.reason}`);

  const row = consumed.row;
  if (row.clientId !== client_id) return err("invalid_grant", "Authorization code was not issued to this client");
  if (row.redirectUri !== redirect_uri) return err("invalid_grant", "redirect_uri does not match");
  if (!verifyPkce(row.codeChallenge, row.codeChallengeMethod, code_verifier)) return err("invalid_grant", "PKCE verification failed");

  const tokens = await issueTokenPair({ clientId: row.clientId, userId: row.userId, scope: row.scope, resource: row.resource });
  return tokenResponse(tokens.accessToken, tokens.refreshToken, tokens.expiresIn, row.scope);
}

// RFC 8628 §3.4–3.5. The client polls here while a human decides, so most calls
// are expected to "fail" with authorization_pending — that is the protocol, not an
// error condition. No PKCE: there is no redirect to intercept, and the device_code
// itself is the 32-byte secret, held only by the client that requested it.
async function handleDeviceCode(body: TokenRequest): Promise<Response> {
  const { device_code, client_id } = body;
  if (!device_code || !client_id)
    return err("invalid_request", "device_code and client_id are required");

  const client = await clientFor(client_id, DEVICE_GRANT_TYPE);
  if (client instanceof Response) return client;

  const result = await pollDeviceCode(device_code, client_id);
  switch (result.status) {
    case "pending":
      // 400 with this code is what the RFC specifies; the client keeps polling.
      return err("authorization_pending", "The user has not yet approved this request");
    case "slow_down":
      return err("slow_down", "Polling too frequently — increase the interval by 5 seconds");
    case "denied":
      return err("access_denied", "The user denied this request");
    case "expired":
      return err("expired_token", "This device code has expired — start a new request");
    case "not_found":
      return err("invalid_grant", "Unknown, already used, or mismatched device_code");
    case "approved": {
      const row = result.row;
      const tokens = await issueTokenPair({
        clientId: row.clientId,
        // Non-null by construction: pollDeviceCode only reports approved when a
        // user is bound to the row.
        userId: row.userId as string,
        scope: row.scope,
        resource: row.resource,
      });
      return tokenResponse(tokens.accessToken, tokens.refreshToken, tokens.expiresIn, row.scope);
    }
  }
}

async function handleRefreshToken(body: TokenRequest): Promise<Response> {
  const { refresh_token, client_id } = body;
  if (!refresh_token || !client_id) return err("invalid_request", "refresh_token and client_id are required");

  const client = await clientFor(client_id, "refresh_token");
  if (client instanceof Response) return client;

  const result = await rotateRefreshToken(refresh_token, client_id);
  if (!result.ok) {
    if (result.reason === "replayed") logger.warn("oauth token replay detected; grant revoked", { clientId: client_id });
    return err("invalid_grant", `Refresh token ${result.reason}`);
  }
  return tokenResponse(result.tokens.accessToken, result.tokens.refreshToken, result.tokens.expiresIn, "mcp");
}
