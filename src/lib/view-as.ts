// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Viewing as another user — the names and the one rule, with no imports, so the
 * proxy, the session code and the browser can all share them.
 *
 * An admin picks a person on Admin → Users and sees the app as that person
 * does. The swap itself is in `getSessionUser()` (src/lib/user.ts); starting
 * and stopping are /api/admin/view-as.
 *
 * LOOK-ONLY, which means nothing is written as them: no history, no saved
 * queries, no drafts, no tokens, no OAuth consent on their behalf. Running a
 * query is not writing, and is allowed — the rule below is the whole of it.
 */

/** Names the person being viewed as. HttpOnly; it grants nothing by itself —
    `getSessionUser()` honours it only for a signed-in admin. */
export const VIEW_AS_COOKIE = "yo-view-as";

/** A readable twin of the cookie above, with no id in it: lets the banner know
    there is something to ask the server about without asking on every page. */
export const VIEW_AS_MARKER_COOKIE = "yo-viewing-as";

/** How long a view-as lasts if nobody stops it. */
export const VIEW_AS_MAX_AGE_SECONDS = 60 * 60;

/** Set by the proxy on every request, so code that only has the request's
    headers can tell a read from a write. */
export const REQUEST_METHOD_HEADER = "x-yo-method";
export const REQUEST_PATH_HEADER = "x-yo-path";

/**
 * The POSTs that may go ahead while viewing as someone: the two that RUN A
 * QUERY. Seeing what a person's queries return is the point of viewing as them
 * — it is how row scoping on a multi-tenant dataset gets tested — and a query
 * is asked for with a POST because its text is a body, not a URL.
 *
 *   /api/dashboards/run   a dashboard loading its data; records nothing
 *   /api/run              the query editor's Run. It normally records the run
 *                         in the person's history and can save it; while
 *                         viewing as, the route does neither (it reads
 *                         `viewedBy` off `getSession()`).
 *
 * Being listed here means "this route runs, and is itself responsible for
 * writing nothing as them" — so add a path only together with that check.
 * Everything else that is not a GET changes something, and is refused: chat,
 * favourites, tokens, sharing, drafts, OAuth consent.
 */
const RUNS_A_QUERY = ["/api/dashboards/run", "/api/run"];

/** May this request go ahead while viewing as someone? */
export function viewAsAllows(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  return m === "POST" && RUNS_A_QUERY.includes(path);
}

/**
 * Paths that are never refused while viewing as someone, whatever the method:
 * the way out (stop), signing out, and the page-view beacon, none of which act
 * as the person being viewed.
 */
const NEVER_REFUSED = ["/api/admin/view-as", "/api/auth/", "/api/telemetry/"];

/** What a refused request is told. One sentence, said the same way by the
    proxy and by `getSession()`. */
export const VIEW_AS_REFUSAL =
  "You are viewing as another user, which is look-only: this would change something as them. " +
  'Press "Stop viewing as" at the top of the page to make changes.';

/**
 * Should the PROXY refuse this request because a view-as is in progress?
 *
 * The authority is `getSession()`, which re-checks who is really signed in. But
 * it can only throw, and the routes turn that into "sign in required" — a
 * sign-in error shown to someone who is signed in. The proxy sees the same
 * request first and can answer it properly, so it does, on the cookie alone.
 *
 * On the cookie ALONE means a stale one (left behind by an admin who has since
 * signed out, on a shared browser) would refuse someone who is viewing as
 * nobody. /api/me clears a cookie that names no live view-as, and the banner
 * calls it on the first page load, so that lasts one request at most.
 */
export function proxyRefusesForViewAs(hasCookie: boolean, method: string, path: string): boolean {
  if (!hasCookie || viewAsAllows(method, path)) return false;
  return !NEVER_REFUSED.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}
