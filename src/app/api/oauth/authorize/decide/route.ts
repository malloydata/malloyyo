// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { auth } from "@/auth";
import { verifyAuthz } from "@/lib/oauth/authz-blob";
import { issueAuthorizationCode } from "@/lib/oauth/codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function plainError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const t = form.get("t");
  const action = form.get("action");

  if (typeof t !== "string") return plainError(400, "Missing authorization request");
  const authz = verifyAuthz(t);
  if (!authz) return plainError(400, "Authorization request expired or invalid — please retry");

  const session = await auth();
  if (!session?.user?.id) return plainError(401, "Not signed in — please retry");

  // Bind the consent to the session that started the flow. A blob minted by one
  // user cannot be approved by another's session — this closes consent CSRF
  // (a lifted blob auto-POSTed from an attacker page) independently of the
  // session cookie's SameSite behavior.
  if (authz.userId !== session.user.id) return plainError(403, "Session mismatch — please retry from your client");

  const url = new URL(authz.redirectUri);
  if (authz.state) url.searchParams.set("state", authz.state);

  if (action !== "approve") {
    url.searchParams.set("error", "access_denied");
    return Response.redirect(url.toString(), 303);
  }

  const code = await issueAuthorizationCode({
    clientId: authz.clientId, userId: session.user.id, redirectUri: authz.redirectUri,
    codeChallenge: authz.codeChallenge, codeChallengeMethod: authz.codeChallengeMethod,
    scope: authz.scope, resource: authz.resource,
  });

  url.searchParams.set("code", code);
  return Response.redirect(url.toString(), 303);
}
