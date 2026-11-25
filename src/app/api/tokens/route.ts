// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Your own API tokens: list them, mint one. Not an admin route — anyone the
// instance admits may hold a token, because a token is never more than its
// owner (src/lib/bearer-auth.ts). A token is only ever minted FOR the caller;
// there is no path here to mint one for somebody else.

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import {
  createApiToken,
  expiryFromDays,
  listApiTokens,
  toView,
  validateScopes,
  validateTokenName,
} from "@/lib/api-tokens";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function me() {
  try {
    return { ok: true as const, user: await getSessionUser() };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { ok: false as const, res: NextResponse.json({ error: err.message }, { status: 401 }) };
    }
    throw err;
  }
}

export async function GET() {
  const who = await me();
  if (!who.ok) return who.res;
  const rows = await listApiTokens(who.user.id);
  return NextResponse.json({ tokens: rows.map((r) => toView(r)) });
}

// { name, scopes: ["publish", …], expiresInDays: number | null }
// The response carries the raw value — the only time it is ever returned.
export async function POST(req: Request) {
  const who = await me();
  if (!who.ok) return who.res;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  const name = validateTokenName(body.name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
  const scopes = validateScopes(body.scopes);
  if (!scopes.ok) return NextResponse.json({ error: scopes.error }, { status: 400 });
  // Absent means never expires — the same as an explicit null, and a choice the
  // form makes deliberately rather than a default nobody picked.
  const expiresAt = expiryFromDays(body.expiresInDays ?? null);
  if (!expiresAt.ok) return NextResponse.json({ error: expiresAt.error }, { status: 400 });

  const created = await createApiToken({
    userId: who.user.id,
    name: name.value,
    scopes: scopes.value,
    expiresAt: expiresAt.value,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 409 });

  logger.info("api token created", {
    userId: who.user.id,
    tokenId: created.token.id,
    prefix: created.token.prefix,
    scopes: created.token.scopes,
    expiresAt: created.token.expiresAt,
  });

  return NextResponse.json(
    { token: toView(created.token), value: created.raw },
    { headers: { "Cache-Control": "no-store" } },
  );
}
