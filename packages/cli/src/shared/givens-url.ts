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

/** Query string -> given values. Keys KEEP their `$` prefix — the runtime
    requires it — and `d` (the dashboard selector) is dropped. */
export function givensFromSearch(search: string): Record<string, string> {
  const g: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (k !== "d") g[k] = v;
  }
  return g;
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
