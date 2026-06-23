// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users, sessions, type User } from "@/db";
import { newUserSlug } from "./slug";

// Auth.js default database-session lifetime (30 days). The cookie value is the
// opaque session token (the `sessions` primary key) — for the database session
// strategy Auth.js stores it verbatim, so we can mint one ourselves and `auth()`
// resolves it like any Google-issued session. See @auth/core defaultCookies().
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Create a throwaway anonymous user (slug only, no email) and a database
 * session for it. The Heroku-style slug is also used as the display `name` so
 * it surfaces everywhere a signed-in name would (header, consent, ltool).
 *
 * Returns the session token + expiry; the caller sets the cookie (via
 * `sessionCookie`) since cookie wiring differs between a route Response and a
 * server action's cookie store.
 */
export async function createAnonymousSession(): Promise<{
  user: User;
  sessionToken: string;
  expires: Date;
}> {
  let user: User | undefined;
  // Retry on the rare slug unique-constraint collision (~525k namespace).
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newUserSlug();
    try {
      [user] = await db.insert(users).values({ slug, name: slug }).returning();
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/users_slug_unique|duplicate key/i.test(msg) || attempt === 4) throw err;
    }
  }
  if (!user) throw new Error("could not create anonymous user");

  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, "")}`;
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await db.insert(sessions).values({ sessionToken, userId: user.id, expires });

  return { user, sessionToken, expires };
}

/**
 * The Auth.js session cookie descriptor. The `__Secure-` prefix and the
 * `secure` flag must match what `auth()` expects when reading the cookie, which
 * Auth.js derives from whether the site is HTTPS — so the caller passes the
 * request's protocol through `secure`.
 */
export function sessionCookie(sessionToken: string, expires: Date, secure: boolean) {
  return {
    name: `${secure ? "__Secure-" : ""}authjs.session-token`,
    value: sessionToken,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure,
      expires,
    },
  };
}
