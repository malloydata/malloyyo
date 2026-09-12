// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Revoke one of your own tokens. Scoped by the session's user id, so an id
// from someone else's list is simply not found — the same answer as a typo,
// which is the answer that reveals nothing.

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { revokeApiToken } from "@/lib/api-tokens";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const { id } = await ctx.params;
  const revoked = await revokeApiToken(user.id, id);
  if (!revoked) return NextResponse.json({ error: "token not found" }, { status: 404 });

  logger.info("api token revoked", { userId: user.id, tokenId: id });
  return NextResponse.json({ ok: true });
}
