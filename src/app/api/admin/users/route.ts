// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { UnauthorizedError } from "@/lib/user";
import { applyUserAction, RosterError, USER_ACTIONS, type UserAction } from "@/lib/roster";

export const runtime = "nodejs";

// One admin action on one user: { userId, action }. The rules (allowed
// transitions, owner protection, no self-revocation) live in src/lib/roster.ts.
export async function POST(req: Request) {
  let actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const body = (await req.json().catch(() => null)) as { userId?: unknown; action?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : null;
  const action = USER_ACTIONS.includes(body?.action as UserAction) ? (body?.action as UserAction) : null;
  if (!userId || !action) {
    return NextResponse.json({ error: `expected { userId, action: ${USER_ACTIONS.join("|")} }` }, { status: 400 });
  }
  try {
    const user = await applyUserAction(actor, userId, action);
    return NextResponse.json({ user: { id: user.id, status: user.status, role: user.role } });
  } catch (err) {
    if (err instanceof RosterError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
