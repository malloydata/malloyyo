// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// RFC 8628 §3.1–3.2. A client with no way to receive a redirect starts here: it
// gets a device_code to poll /api/oauth/token with, and a short user_code for a
// human to type at verification_uri. Nothing listens on the client side, which is
// what makes this work in a container, a Codespace (where `localhost` is the
// user's laptop, not the machine running the CLI), over plain SSH, or in CI.
//
// Unauthenticated, like /register and /authorize's first leg: starting a flow
// grants nothing. Authorization happens when a signed-in human approves the user
// code, and only then does the device_code become exchangeable.

import { NextResponse } from "next/server";
import { clientMayUse, getOAuthClient } from "@/lib/oauth/clients";
import { originFromRequest } from "@/lib/oauth/base-url";
import { corsPreflight, withCors } from "@/lib/oauth/cors";
import { issueDeviceCode, DEVICE_GRANT_TYPE } from "@/lib/oauth/device-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(error: string, description: string, status = 400): Response {
  return withCors(
    NextResponse.json(
      { error, error_description: description },
      { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    ),
  );
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request): Promise<Response> {
  // Same tolerant body parsing as /token: clients send form-encoded per the RFC,
  // but JSON is common enough that rejecting it is a pointless papercut.
  let params: Record<string, string> = {};
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      params = (await request.json()) as Record<string, string>;
    } else {
      const form = new URLSearchParams(await request.text());
      for (const [k, v] of form.entries()) params[k] = v;
    }
  } catch {
    return err("invalid_request", "Could not parse request body");
  }

  const clientId = params.client_id;
  if (!clientId) return err("invalid_request", "client_id is required");

  const client = await getOAuthClient(clientId);
  if (!client) return err("invalid_client", "Unknown client_id");
  // The client must have registered for this grant. Dynamic registration records
  // grant_types, so a client that never asked for it cannot start a device flow.
  if (!clientMayUse(client, DEVICE_GRANT_TYPE)) {
    return err("unauthorized_client", `Client is not registered for ${DEVICE_GRANT_TYPE}`);
  }

  const scope = params.scope ?? "mcp";
  if (scope !== "mcp") return err("invalid_scope", `Unsupported scope: ${scope}`);

  const issued = await issueDeviceCode({
    clientId,
    scope,
    resource: params.resource ?? null,
  });

  const origin = originFromRequest(request);
  const verificationUri = `${origin}/oauth/device`;
  return withCors(
    NextResponse.json(
      {
        device_code: issued.deviceCode,
        user_code: issued.userCode,
        verification_uri: verificationUri,
        // Convenience only. The CLI prints the plain URI and the code separately:
        // a link that carries the code is the device-flow phishing vector (§5.4),
        // so it is offered, never auto-opened.
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(issued.userCode)}`,
        expires_in: issued.expiresIn,
        interval: issued.interval,
      },
      { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    ),
  );
}
