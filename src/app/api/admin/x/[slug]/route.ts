// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The action endpoint behind a contributed admin page (src/lib/hosted-auth.ts).
//
// The same division as the page shell: this file authorizes the administrator and finds
// the page; request bodies, method policy, and responses are the integration's. Every
// method lands in one dispatch so a page that wants DELETE tomorrow needs no change
// here — a page without a handler, or a slug without a page, answers 404 like an
// unimplemented handoff.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import { UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

async function dispatch(
  request: Request,
  ctx: RouteContext<"/api/admin/x/[slug]">,
): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const { slug } = await ctx.params;
  const page = hostedIntegration()?.adminPages?.find((p) => p.slug === slug);
  if (!page?.handleAction) return NextResponse.json({ error: "not found" }, { status: 404 });
  return page.handleAction(request);
}

export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE };
