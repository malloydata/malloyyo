// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// GET    /api/chats/[id] — the conversation, as the screen needs it.
// DELETE /api/chats/[id]

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { deleteChat, loadForDisplay, ownedChat } from "@/lib/chat/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    throw err;
  }
  const { id } = await ctx.params;
  const chat = await ownedChat(id, user.id);
  // 404 for someone else's chat as well as a missing one: which it is, is not
  // something a stranger gets to learn.
  if (!chat) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { messages, results } = await loadForDisplay(id);
  return NextResponse.json({ chat, messages, results });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    throw err;
  }
  const { id } = await ctx.params;
  const gone = await deleteChat(id, user.id);
  if (!gone) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
