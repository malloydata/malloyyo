// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { getSessionUserOrNull } from "@/lib/user";
import { signInPath } from "@/lib/auth-paths";
import { getOAuthClient, isRegisteredRedirect } from "@/lib/oauth/clients";
import { signAuthz } from "@/lib/oauth/authz-blob";
import { originFromRequest } from "@/lib/oauth/base-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function plainError(status: number, error: string, description: string): Response {
  return new Response(`${error}: ${description}`, { status, headers: { "Content-Type": "text/plain" } });
}

function redirectError(redirectUri: string, error: string, state: string | null, description?: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const p = url.searchParams;

  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const responseType = p.get("response_type");
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method");
  const requestedScope = (p.get("scope") ?? "").trim();
  const state = p.get("state");
  const resource = p.get("resource");

  if (!clientId) return plainError(400, "invalid_request", "client_id is required");
  const client = await getOAuthClient(clientId);
  if (!client) return plainError(400, "invalid_client", "Unknown client_id");
  if (!redirectUri) return plainError(400, "invalid_request", "redirect_uri is required");
  if (!isRegisteredRedirect(client, redirectUri)) return plainError(400, "invalid_request", "redirect_uri is not registered for this client");

  if (responseType !== "code") return redirectError(redirectUri, "unsupported_response_type", state, 'Only "code" is supported');
  if (!codeChallenge || codeChallengeMethod !== "S256") return redirectError(redirectUri, "invalid_request", state, "PKCE S256 is required");

  const scope = requestedScope || "mcp";
  if (scope !== "mcp") return redirectError(redirectUri, "invalid_scope", state, `Unsupported scope: ${scope}`);

  // The local user row, whichever sign-in produced it. `userId` below is bound into the
  // consent blob and compared on approval, so it must be this deployment's own user ID —
  // never an external identifier, which is what a contributed provider's raw session may
  // carry.
  const user = await getSessionUserOrNull();
  if (!user) {
    const origin = originFromRequest(request);
    const signInUrl = new URL(signInPath(url.pathname + url.search), origin);
    return Response.redirect(signInUrl.toString(), 302);
  }

  const token = signAuthz({
    userId: user.id,
    clientId, redirectUri, scope, codeChallenge, codeChallengeMethod: "S256",
    resource: resource || null, state: state || null,
  });

  const consent = new URL("/oauth/consent", originFromRequest(request));
  consent.searchParams.set("t", token);
  return Response.redirect(consent.toString(), 302);
}
