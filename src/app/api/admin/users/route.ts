// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { UnauthorizedError } from "@/lib/user";
import { hostedSignIn } from "@/lib/hosted-auth-integration";
import {
  addUser,
  applyUserAction,
  removeAddedUser,
  RosterError,
  USER_ACTIONS,
  type UserAction,
} from "@/lib/roster";

export const runtime = "nodejs";

// Admin actions on people. The rules (allowed transitions, owner protection,
// no self-revocation) live in src/lib/roster.ts.
//
//   { action: "add", email, roles }     add someone ahead of their first sign-in,
//                                       holding exactly those roles. If the
//                                       address is waiting for approval, this
//                                       approves it; the answer says which.
//   { action: "remove", userId }        take back someone added who has not
//                                       signed in yet.
//   { action: approve|deny|disable|enable|promote|demote, userId }
export async function POST(req: Request) {
  let actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = typeof body?.userId === "string" ? body.userId : null;
  try {
    if (body?.action === "add" || body?.action === "remove") {
      // Where an integration owns sign-in, who is a member is decided there:
      // a row made here could never be claimed, and would sit in the list as a
      // person who does not exist.
      if (hostedSignIn()) {
        return NextResponse.json({ error: "people are added at the identity provider on this instance" }, { status: 400 });
      }
      if (body.action === "remove") {
        if (!userId) return NextResponse.json({ error: "expected { action: \"remove\", userId }" }, { status: 400 });
        await removeAddedUser(actor, userId);
        return NextResponse.json({ ok: true });
      }
      const email = typeof body.email === "string" ? body.email : null;
      const roles = Array.isArray(body.roles) ? body.roles.filter((r): r is string => typeof r === "string") : null;
      if (!email || !roles) {
        return NextResponse.json({ error: "expected { action: \"add\", email, roles }" }, { status: 400 });
      }
      const outcome = await addUser(actor, email, roles);
      return NextResponse.json({ kind: outcome.kind, user: { id: outcome.user.id, status: outcome.user.status } });
    }

    const action = USER_ACTIONS.includes(body?.action as UserAction) ? (body?.action as UserAction) : null;
    if (!userId || !action) {
      return NextResponse.json(
        { error: `expected { userId, action: ${USER_ACTIONS.join("|")} } or { action: "add", email, roles }` },
        { status: 400 },
      );
    }
    const user = await applyUserAction(actor, userId, action);
    return NextResponse.json({ user: { id: user.id, status: user.status, role: user.role } });
  } catch (err) {
    if (err instanceof RosterError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
