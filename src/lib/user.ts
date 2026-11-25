// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, users, type User } from "@/db";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { authorize } from "./authorize";
import { hasRole, MALLOYYO_ADMIN } from "./roles";
import { REQUEST_METHOD_HEADER, REQUEST_PATH_HEADER, VIEW_AS_COOKIE, viewAsAllows } from "./view-as";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * The person ACTUALLY signed in — never the one being viewed as.
 *
 * Almost nothing should call this: `getSessionUser()` is the identity every
 * page and route acts as. It exists for the view-as controls themselves, which
 * have to know who is really there in order to start and stop.
 */
export async function getRealSessionUser(): Promise<User> {
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

/**
 * The user this request acts as: whoever is signed in — or, while an admin is
 * VIEWING AS someone, that person.
 *
 * Viewing as (src/lib/view-as.ts) swaps the identity here, in the one function
 * every page and session route already goes through, so the admin sees exactly
 * what that person sees: their datasets, their dashboards, their rows under
 * row scoping, and no admin pages. It is LOOK-ONLY. Anything that would write
 * as them is refused below, except the one read that is a POST.
 */
export async function getSessionUser(): Promise<User> {
  const real = await getRealSessionUser();
  const target = await viewedAs(real);
  if (!target) return real;

  const request = await requestLine();
  if (!viewAsAllows(request.method, request.path)) {
    throw new UnauthorizedError(
      `You are viewing as ${target.name ?? target.email ?? "another user"}, which is look-only. ` +
        "Stop viewing as them to make changes.",
    );
  }
  return target;
}

/** Who is being viewed as, and by whom — for the banner and for stopping. */
export async function getViewAs(): Promise<{ real: User; target: User } | null> {
  const real = await getRealSessionUser();
  const target = await viewedAs(real);
  return target ? { real, target } : null;
}

/**
 * The person this admin is viewing as, or null.
 *
 * Re-decided on every request from rows read on that request, the same way
 * authorization is: the cookie only NAMES someone. It grants nothing to a
 * non-admin, so a stale or forged one is ignored, and it stops working the
 * moment the admin is demoted or the target is disabled or made an admin.
 */
async function viewedAs(real: User): Promise<User | null> {
  let id: string | undefined;
  try {
    const { cookies } = await import("next/headers");
    id = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  } catch {
    return null; // no request scope: nothing to view as
  }
  if (!id || !UUID_RE.test(id) || id === real.id) return null;
  if (!hasRole(real, MALLOYYO_ADMIN)) return null;
  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target || !authorize(target).allowed) return null;
  // Not another admin: that would be acting with someone else's authority,
  // which is a different thing from seeing what a reader sees.
  if (hasRole(target, MALLOYYO_ADMIN)) return null;
  return target;
}

/** The request's method and path, as the proxy recorded them (src/proxy.ts).
    Missing means the proxy did not see this request, which is treated as a
    write to an unknown path: refused. */
async function requestLine(): Promise<{ method: string; path: string }> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    return { method: h.get(REQUEST_METHOD_HEADER) ?? "", path: h.get(REQUEST_PATH_HEADER) ?? "" };
  } catch {
    return { method: "", path: "" };
  }
}

// Keep for internal use by the ingest workflow which doesn't have a session.
export async function getDefaultUser(): Promise<User> {
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await db.insert(users).values({ status: "active" }).returning();
  return created;
}
