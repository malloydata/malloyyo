// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A cross-host sign-in handoff, when an integration implements one.
//
// A shell, and deliberately a generic path: the application does not know what is handed
// over or who hands it, only that the integration asked for an endpoint. Where no
// integration is installed — or one is installed that admits people only on this host —
// this answers 404, so an unimplemented handoff looks exactly like a route that was never
// there rather than like one that is broken.
//
// Everything that makes such a handoff safe (which origins may post to it, what the
// payload is, and what it is exchanged for) belongs to the integration and is enforced
// inside `handleHandoff`.

import { hostedIntegration } from "@/lib/hosted-auth-integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const handle = hostedIntegration()?.handleHandoff;
  if (!handle) return new Response("Not Found", { status: 404 });
  return handle(request);
}
