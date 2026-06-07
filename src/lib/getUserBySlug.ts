// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users } from "@/db";
import { eq } from "drizzle-orm";

export async function getUserBySlug(slug: string) {
  const [row] = await db.select().from(users).where(eq(users.slug, slug)).limit(1);
  return row;
}
