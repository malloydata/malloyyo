// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users, type User } from "@/db";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { newUserSlug } from "./slug";

export class UnauthorizedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnauthorizedError";
  }
}

/**
 * Returns the currently signed-in user, ensuring they have a slug.
 * Throws UnauthorizedError if no session exists.
 */
import { isEmailAllowed } from "./allowlist";
export { isEmailAllowed };

export async function getSessionUser(): Promise<User> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new UnauthorizedError("not signed in");
  }
  if (!isEmailAllowed(session.user.email)) {
    throw new UnauthorizedError("not authorized");
  }
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!u) throw new UnauthorizedError("user not found");

  if (!u.slug) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const [updated] = await db
          .update(users)
          .set({ slug: newUserSlug() })
          .where(eq(users.id, u.id))
          .returning();
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/users_slug_unique|duplicate key/i.test(msg) || attempt === 4) {
          throw err;
        }
      }
    }
  }
  return u;
}

// Keep for internal use by the ingest workflow which doesn't have a session.
export async function getDefaultUser(): Promise<User> {
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) return existing[0];

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [created] = await db
        .insert(users)
        .values({ slug: newUserSlug() })
        .returning();
      return created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/users_slug_unique|duplicate key/i.test(msg) || attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}
