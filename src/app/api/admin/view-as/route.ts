// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Start and stop viewing the app as another user.
//
//   POST    { userId }   an admin starts viewing as that person
//   DELETE               stop
//
// The swap itself happens in `getSessionUser()` (src/lib/user.ts), which is
// also where it is re-checked on every request. This route only names who, in
// a cookie that grants nothing by itself, and writes down that it happened.
//
// Both handlers ask who is REALLY signed in — the one place that must not be
// answered with the person being viewed as, or nobody could ever stop.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { authorize } from "@/lib/authorize";
import { hasRole, MALLOYYO_ADMIN } from "@/lib/roles";
import { getRealSessionUser, UnauthorizedError } from "@/lib/user";
import { logger } from "@/lib/logger";
import { VIEW_AS_COOKIE, VIEW_AS_MARKER_COOKIE, VIEW_AS_MAX_AGE_SECONDS } from "@/lib/view-as";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

async function realUser() {
  try {
    return await getRealSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return null;
    throw err;
  }
}

function setCookies(res: NextResponse, userId: string | null) {
  const base = { path: "/", sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" };
  const maxAge = userId ? VIEW_AS_MAX_AGE_SECONDS : 0;
  res.cookies.set(VIEW_AS_COOKIE, userId ?? "", { ...base, httpOnly: true, maxAge });
  // Readable, and carries no id: only "there is something to ask about".
  res.cookies.set(VIEW_AS_MARKER_COOKIE, userId ? "1" : "", { ...base, httpOnly: false, maxAge });
  return res;
}

export async function POST(req: Request) {
  const actor = await realUser();
  if (!actor) return bad("sign in first", 401);
  if (!hasRole(actor, MALLOYYO_ADMIN)) return bad("only an admin can impersonate another user", 403);

  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!UUID_RE.test(userId)) return bad("userId is required");
  if (userId === actor.id) return bad("that is you — there is nobody to impersonate");

  // The same conditions `getSessionUser()` applies on every request, checked
  // here too so the refusal comes with a reason instead of a view-as that
  // silently does nothing.
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return bad("no such user", 404);
  if (!authorize(target).allowed) return bad("that person cannot sign in, so there is nothing to see as them");
  if (hasRole(target, MALLOYYO_ADMIN)) return bad("admins cannot be impersonated");

  // Kept: who looked as whom, and when. This is the record the banner promises.
  logger.info("view-as started", { actorId: actor.id, targetId: target.id });
  return setCookies(NextResponse.json({ ok: true, viewingAs: { id: target.id, name: target.name, email: target.email } }), target.id);
}

export async function DELETE() {
  const actor = await realUser();
  if (actor) logger.info("view-as stopped", { actorId: actor.id });
  // Cleared whoever asks, signed in or not: stopping is never the wrong answer.
  return setCookies(NextResponse.json({ ok: true }), null);
}
