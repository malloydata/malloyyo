// The URL <-> givens encoding, in ONE place.
//
// Both hosts need it and they used to have separate copies: `dashboard dev`
// parsed the query server-side, and the static bundle re-implemented it in an
// inline script. The copies drifted — the static one stripped the `$` prefix
// that the runtime keys off (runtime.tsx: `if (k[0] === "$")`), so shareable
// links silently fell back to defaults. That class of bug is the reason this
// module exists; import it instead of writing the loop again.
//
// Deliberately dependency-free (no React, no node builtins) so the Node dev
// server and the browser bundle can share the same file.

// Two namespaces share the query string and must never collide:
//   `$NAME`  a GIVEN — the governed, filter-typed query contract (declared in
//            the model, drives the auto-rendered controls, MCP-visible).
//   `~key`   a custom component's VIEW-STATE (useUrlState): a rack string, a
//            board layout, a checkbox. Not a query parameter; the runtime
//            round-trips it verbatim so JS-driven components get shareable links.
export const URL_STATE_PREFIX = "~";

/** Query string -> given values. Keys KEEP their `$` prefix — the runtime
    requires it — while `d` (the dashboard selector) and the `~` view-state
    namespace are dropped. */
export function givensFromSearch(search: string): Record<string, string> {
  const g: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (k !== "d" && k.charAt(0) !== URL_STATE_PREFIX) g[k] = v;
  }
  return g;
}

/** Query string -> view-state values (`useUrlState`). Keys KEEP their `~`
    prefix, mirroring givensFromSearch: the runtime strips it itself. */
export function urlStateFromSearch(search: string): Record<string, string> {
  const s: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (k.charAt(0) === URL_STATE_PREFIX) s[k] = v;
  }
  return s;
}

/** View-state -> `~`-prefixed query params. Accepts keys with or without the
    prefix. Unlike givens, an EMPTY STRING is kept: a component whose default is
    non-empty needs `~rack=` to mean "the user cleared it" (the runtime already
    drops keys that equal their default, so nothing pointless reaches here). */
export function urlStateToParams(state: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state ?? {})) {
    if (v == null) continue;
    p.set(k.charAt(0) === URL_STATE_PREFIX ? k : URL_STATE_PREFIX + k, String(v));
  }
  return p;
}

/** The one shareable query string: `d` (when the host uses a selector) +
    `$givens` + `~view-state`, in that order. Returns "" or "?…". */
export function shareSearch(opts: {
  d?: string;
  givens?: Record<string, unknown>;
  urlState?: Record<string, unknown>;
}): string {
  const p = new URLSearchParams();
  if (opts.d != null) p.set("d", opts.d);
  for (const [k, v] of givensToParams(opts.givens ?? {})) p.set(k, v);
  for (const [k, v] of urlStateToParams(opts.urlState ?? {})) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

/** Given values -> `$`-prefixed query params, skipping empties. Accepts keys
    with or without the prefix so callers can pass either the runtime's bare
    names or values already read out of a URL. */
export function givensToParams(givens: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(givens ?? {})) {
    if (v == null || String(v) === "") continue;
    p.set(k.charAt(0) === "$" ? k : "$" + k, String(v));
  }
  return p;
}
