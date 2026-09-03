// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// GET    /api/chats/[id] — the conversation, as the screen needs it.
// PATCH  /api/chats/[id] — publish or unpublish it.
// DELETE /api/chats/[id]
//
// GET reads; the other two write. That split is the whole authorization story:
// reading goes through `readableChat` (mine, or published), and every write goes
// through owner-scoped calls. A published chat can be read and never added to.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { deleteChat, loadForDisplay, readableChat, setChatPublic } from "@/lib/chat/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function requireUser() {
  try {
    return { user: await getSessionUser() };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { error: NextResponse.json({ error: "sign in required" }, { status: 401 }) };
    }
    throw err;
  }
}

export async function GET(_req: Request, ctx: Ctx) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { id } = await ctx.params;
  const found = await readableChat(id, user.id);
  // 404 for a chat you may not read as well as a missing one: which it is, is
  // not something a stranger gets to learn.
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { messages, results } = await loadForDisplay(id);
  // `mine` is what the UI hangs the composer and the publish control on. Sent
  // rather than inferred: the client does not know who owns a chat it was
  // handed, and guessing from the URL is how a read-only view grows a text box
  // that fails on submit.
  return NextResponse.json({ chat: found.chat, mine: found.mine, messages, results });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { id } = await ctx.params;
  let body: { isPublic?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.isPublic !== "boolean") {
    return NextResponse.json({ error: "isPublic is required" }, { status: 400 });
  }

  // Publishing a chat publishes its ROWS. On a private dataset that would route
  // straight around the dataset's own privacy — the thing every other read path
  // is careful about — so it is refused here rather than left to the caller.
  // Unpublishing is always allowed: taking something back must never be blocked
  // by the state that made it a problem.
  if (body.isPublic) {
    const owned = await readableChat(id, user.id);
    if (!owned?.mine) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [ds] = await db
      .select({ isPublic: datasets.isPublic })
      .from(datasets)
      .where(eq(datasets.name, owned.chat.dataset));
    if (!ds?.isPublic) {
      return NextResponse.json(
        { error: `'${owned.chat.dataset}' is a private dataset — a chat on it cannot be shared.` },
        { status: 400 },
      );
    }
  }

  const updated = await setChatPublic(id, user.id, body.isPublic);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id: updated.id, isPublic: updated.isPublic });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { id } = await ctx.params;
  const gone = await deleteChat(id, user.id);
  if (!gone) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
