// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Viewing as another user — the names and the one rule, with no imports, so the
 * proxy, the session code and the browser can all share them.
 *
 * An admin picks a person on Admin → Roles and sees the app as that person
 * does. The swap itself is in `getSessionUser()` (src/lib/user.ts); starting
 * and stopping are /api/admin/view-as.
 *
 * LOOK-ONLY. While viewing as someone, nothing may be written as them: no saved
 * queries, no drafts, no tokens, no OAuth consent on their behalf. The rule
 * below is the whole of that.
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
 * The writes that are really reads. A dashboard asks for its data with a POST
 * (the query and its control values are a body, not a URL); it records nothing
 * as the user. Everything else that is not a GET changes something.
 */
const READS_BY_POST = ["/api/dashboards/run"];

/** May this request go ahead while viewing as someone? */
export function viewAsAllows(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  return READS_BY_POST.includes(path);
}
