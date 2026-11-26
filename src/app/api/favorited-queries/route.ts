// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, and, ne, or, inArray, sql, desc } from "drizzle-orm";
import { MALLOYYO_ADMIN, othersActivityReadableSql } from "@/lib/roles";
import { db, datasets, savedQueries, favorites, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// Saved queries favorited by the CALLER or by an ADMIN — not everyone's
// favorites — scoped to datasets the caller can see (same visibility as
// /api/sources). One row per qualifying saved query with its total favorite
// count, most-favorited first. The front page groups these by (dataset,
// source) and lists a few under each source.
export async function GET() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) me = null;
    else throw err;
  }

  // Signed out (or pending, or disabled): nothing. Which datasets every member
  // can open is not something to tell someone who is not a member.
  if (!me) return NextResponse.json([]);

  const admin = isAdmin(me);
  // The SAME rule the share link behind each row is checked with
  // (/api/ltool/share/[slug]): a saved query you authored is yours; someone
  // else's shows only where their activity on that dataset is readable to you —
  // open to every member, you being one, and not scoped per person, since a
  // favourite's question is then one tenant's. So the list never offers a link
  // that answers "not found".
  const visible = admin
    ? ne(datasets.status, "failed")
    : and(
        ne(datasets.status, "failed"),
        or(eq(savedQueries.userId, me.id), othersActivityReadableSql(me.id)),
      );

  // Whose favorites count: mine + every admin's (admin = role column, the
  // legacy is_admin column, OR the APP_ADMIN_EMAILS list, which isn't stored
  // on the row) — the same three sources isAdmin() consults.
  const adminEmails = env.APP_ADMIN_EMAILS.map((e) => e.toLowerCase());
  const adminUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(or(
      // The role list first: it is how someone is made an admin now, and an
      // admin who is one only there was being left out of "admins' favourites".
      sql`${MALLOYYO_ADMIN} = any(coalesce(${users.roles}, '{}'::text[]))`,
      inArray(users.role, ["owner", "admin"]),
      eq(users.isAdmin, true),
      adminEmails.length ? inArray(sql`lower(${users.email})`, adminEmails) : sql`false`,
    ));
  const allowedFavoriters = [...new Set([...(me ? [me.id] : []), ...adminUsers.map((u) => u.id)])];
  if (allowedFavoriters.length === 0) return NextResponse.json([]);

  const favRows = await db
    .select({ savedQueryId: favorites.savedQueryId })
    .from(favorites)
    .where(inArray(favorites.userId, allowedFavoriters));
  const qualifyingIds = [...new Set(favRows.map((r) => r.savedQueryId))];
  if (qualifyingIds.length === 0) return NextResponse.json([]);

  const favCount = sql<number>`(SELECT count(*)::int FROM favorites f WHERE f.saved_query_id = ${savedQueries.id})`;

  const rows = await db
    .select({
      // By NAME, not id — and that is a KNOWN DEFECT, not a design. A dataset
      // name is unique only inside its repo now, so when two repos each publish
      // an `orders` the front page's join puts both cards' favourites together
      // (src/app/page.tsx says the same thing from the consuming side: wrong,
      // but symmetrically wrong, which beats one card vanishing). This endpoint
      // predates repos and has not been threaded through; it should return the
      // qualified name. Do not read this as an invariant — it used to claim one.
      dataset: datasets.name,
      source: savedQueries.source,
      slug: savedQueries.slug,
      question: savedQueries.question,
      favoriteCount: favCount,
    })
    .from(savedQueries)
    .innerJoin(datasets, eq(datasets.id, savedQueries.datasetId))
    .where(and(visible, inArray(savedQueries.id, qualifyingIds)))
    // Most recently used (saved) first — the front page groups these by dataset
    // and preserves this order within each group.
    .orderBy(desc(savedQueries.createdAt), desc(favCount))
    .limit(500);

  return NextResponse.json(rows);
}
