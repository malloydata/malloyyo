// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// GET  /api/chats — this user's chats, newest activity first.
// POST /api/chats — start one, scoped to a dataset:source.

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { askEnabled } from "@/lib/ask";
import { createChat, listChats } from "@/lib/chat/store";

export const runtime = "nodejs";

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

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  return NextResponse.json(await listChats(user.id));
}

export async function POST(req: Request) {
  // Same gate as /api/ask: no key, no feature. Checked before auth so an
  // unconfigured instance says so rather than asking you to sign in first.
  if (!askEnabled()) {
    return NextResponse.json({ error: "Chat is not configured on this instance." }, { status: 503 });
  }
  const { user, error } = await requireUser();
  if (error) return error;

  let body: { dataset?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const dataset = body.dataset?.trim() ?? "";
  const source = body.source?.trim() ?? "";
  // Both, because a source name alone is not unique — two datasets may each
  // define an "orders", and the pair is what identifies one.
  if (!dataset || !source) {
    return NextResponse.json({ error: "dataset and source are required" }, { status: 400 });
  }

  return NextResponse.json(await createChat({ userId: user.id, dataset, source }));
}
