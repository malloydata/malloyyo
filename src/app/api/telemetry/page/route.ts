// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { auth } from "@/auth";
import { captureTelemetry, normalizePagePath } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { pathname?: unknown };
  try {
    body = (await req.json()) as { pathname?: unknown };
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof body.pathname !== "string") return new Response(null, { status: 400 });

  const session = await auth();
  void captureTelemetry(
    {
      event: "page viewed",
      properties: {
        page: normalizePagePath(body.pathname),
        authenticated: Boolean(session?.user?.id),
      },
    },
    session?.user?.id,
  );
  return new Response(null, { status: 204 });
}
