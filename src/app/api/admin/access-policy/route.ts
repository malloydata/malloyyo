// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { UnauthorizedError } from "@/lib/user";
import { ACCESS_POLICIES, getAccessPolicy, setAccessPolicy, type AccessPolicy } from "@/lib/access-policy";

export const runtime = "nodejs";

// The instance's admission rule: { policy: "open" | "invite" }. A visible,
// auditable admin action — the thing EMAIL_ALLOW_LIST used to approximate.
export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const body = (await req.json().catch(() => null)) as { policy?: unknown } | null;
  const policy = ACCESS_POLICIES.includes(body?.policy as AccessPolicy) ? (body?.policy as AccessPolicy) : null;
  if (!policy) {
    return NextResponse.json({ error: `expected { policy: ${ACCESS_POLICIES.join("|")} }` }, { status: 400 });
  }
  await setAccessPolicy(policy);
  return NextResponse.json({ policy: await getAccessPolicy() });
}
