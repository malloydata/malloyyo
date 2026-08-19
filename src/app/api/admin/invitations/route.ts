// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { UnauthorizedError } from "@/lib/user";
import { createInvitation, revokeInvitation, RosterError } from "@/lib/roster";

export const runtime = "nodejs";

// Create a standing invitation: { email, role?: "member" | "admin" }.
// Inviting an address already waiting in the queue approves it instead —
// the route reports which happened so the UI can say so.
export async function POST(req: Request) {
  let actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const body = (await req.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : null;
  const role = body?.role === "admin" ? "admin" : "member";
  if (!email) return NextResponse.json({ error: "expected { email, role? }" }, { status: 400 });
  try {
    const outcome = await createInvitation(actor, email, role);
    return NextResponse.json(
      outcome.kind === "invited"
        ? { kind: "invited", invitation: { id: outcome.invitation.id, email: outcome.invitation.email, role: outcome.invitation.role } }
        : { kind: "approved", user: { id: outcome.user.id, status: outcome.user.status, role: outcome.user.role } },
    );
  } catch (err) {
    if (err instanceof RosterError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

// Withdraw an open invitation: DELETE ?id=<invitation id>.
export async function DELETE(req: Request) {
  let actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "expected ?id=<invitation id>" }, { status: 400 });
  try {
    await revokeInvitation(actor, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RosterError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
