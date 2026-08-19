// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users, type User } from "@/db";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { authorize } from "./authorize";

export class UnauthorizedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnauthorizedError";
  }
}

/** getSessionUser(), but null instead of throwing — for routes that offer a sign-in. */
export async function getSessionUserOrNull(): Promise<User | null> {
  try {
    return await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return null;
    throw err;
  }
}

export async function getSessionUser(): Promise<User> {
  // One session system for every deployment. On a hosted instance the row was created (and
  // its admin role reconciled) by the sign-in provider's authorize(); by the time a request
  // carries a session, the user exists.
  const session = await auth();
  if (!session?.user?.id) {
    throw new UnauthorizedError("not signed in");
  }
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!u) throw new UnauthorizedError("user not found");

  // Authorization, against the row just read — never against session claims.
  // This per-request read is what makes revocation instant: a `disabled` row
  // refuses the very next request, whatever the session token still says.
  const authz = authorize(u);
  if (!authz.allowed) throw new UnauthorizedError(authz.reason);

  return u;
}

// Keep for internal use by the ingest workflow which doesn't have a session.
export async function getDefaultUser(): Promise<User> {
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await db.insert(users).values({ status: "active" }).returning();
  return created;
}
