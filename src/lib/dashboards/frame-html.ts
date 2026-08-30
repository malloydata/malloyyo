// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// HTML assembly for the dashboard frame document: JSON escaping, the URL-state
// bootstrap, and the response CSP. It lives here rather than inline in the route
// so the security-relevant parts are unit-testable (see
// src/lib/dashboard-frame-html.test.ts) — the route itself is then just I/O.
//
// THE RULE: nothing derived from the REQUEST is ever interpolated into this
// document. Only model-derived values (the dashboard's own title, info and
// given specs, which come from the repo's Malloy model) are inlined, and those
// still go through safeJson/esc.
//
// Why the rule exists. A script element's content is RAW TEXT terminated by the
// literal `</script`, so a value containing `</script><script>…` closes the
// block and returns the parser to HTML context — script execution straight out
// of a query parameter. `JSON.stringify` escapes quotes and backslashes; it does
// NOT escape `<`. That was a live reflected-XSS bug here (the route is reachable
// as a top-level navigation, so the embedder's iframe sandbox did not contain
// it), fixed first by escaping every sink with safeJson().
//
// Escaping the sink is now the SECOND line rather than the only one: the
// shareable-link state (`?$given=…` and useUrlState's `?~key=…`) is no longer
// reflected at all. The frame's own document URL already carries the query
// string — CustomDashboardFrame sets `frame.src = …/frame` + location.search —
// so FRAME_BOOTSTRAP below parses it client-side instead. That is a constant
// with no interpolation, so the request data stays data and never becomes
// source text. It is also what the other hosts already did (the static bundle's
// frame-wasm-entry.tsx and the in-page TagOnlyDashboard both read
// location.search directly); this brings the hosted frame in line with them.
//
// If you add a new value to this document, it must be model-derived and go
// through safeJson(). Request-derived state belongs in FRAME_BOOTSTRAP.

import { normalizeImageHosts } from "./image-hosts";

/** JSON for embedding inside an inline <script>. Escaping `<` (and `>` for
    symmetry) is what closes the XSS hole: `</script` can no longer appear in
    the output, so the element cannot be terminated early. The two line
    terminators are a separate correctness fix — U+2028/U+2029 are legal raw
    inside a JSON string but are literal line terminators in JS source, so an
    unescaped one is a syntax error. All four escapes are inside string literals
    only, so `JSON.parse` of the result is unchanged. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The shareable-link bootstrap, run in the frame before the runtime loads.

    A CONSTANT — it must never gain an interpolation. Its whole purpose is that
    the request's query string reaches the page as DATA (already sitting in
    location.search) instead of as source text, which is what makes the two
    namespaces below un-injectable rather than merely well-escaped.

    It sets the same two globals the runtime already reads
    (frame-runtime/runtime.tsx: `window.__INITIAL_GIVENS__ || {}` and
    `window.__INITIAL_URLSTATE__ || {}`), in the same shape, so the runtime and
    every other host are untouched by this:

      `$NAME`  a GIVEN — the governed, filter-typed query contract. Keys keep
               the `$` prefix (the runtime strips it) and are allow-listed
               against the declared specs in `window.__GIVENS__`, matched
               case-insensitively exactly as the runtime matches them. A spec
               without a string name declares nothing, so it fails closed.
      `~key`   useUrlState VIEW-STATE — a custom component's own scratch state
               (a rack, a board). Keys keep the `~` prefix. There is deliberately
               no allow-list here and there cannot be one: these keys are
               invented by the component author at runtime and never declared in
               the model, so nothing server-side knows the legitimate set. That
               is precisely why this runs client-side — an unbounded namespace
               that is never reflected needs no allow-list to be safe.

    Written as ES5-flavoured script text (var/function, no arrow or const): it
    is emitted verbatim into the document, not compiled with the rest of the
    app. */
export const FRAME_BOOTSTRAP = `(function(){
  var p = new URLSearchParams(location.search);
  var declared = {};
  var specs = window.__GIVENS__ || [];
  for (var i = 0; i < specs.length; i++) {
    var n = specs[i] && specs[i].name;
    if (typeof n === "string") declared[n.toLowerCase()] = 1;
  }
  var givens = {}, urlState = {};
  p.forEach(function (v, k) {
    var c = k.charAt(0);
    if (c === "$") { if (declared[k.slice(1).toLowerCase()]) givens[k] = v; }
    else if (c === "~") { urlState[k] = v; }
  });
  window.__INITIAL_GIVENS__ = givens;
  window.__INITIAL_URLSTATE__ = urlState;
})();`;

/** The frame response's Content-Security-Policy.

    `sandbox` is the important directive. The document is *meant* to run
    sandboxed, but until now that was a property of the embedding page
    (CustomDashboardFrame's `sandbox` attribute) rather than of the response —
    and the route is a plain GET under /api/, which proxy.ts passes straight
    through, so it is reachable as a top-level navigation with no sandbox at
    all. Sending the directive here makes the opaque origin a property of the
    response, so the containment holds however the document is reached. The
    token list matches the iframe attribute; `allow-popups*` keeps `# link`
    deep links working.

    `script-src` is nonce-only: no injected inline script can execute, and the
    two scripts we emit carry the nonce. `'unsafe-eval'` is present because the
    bundled renderer's CSV/expression paths compile with the `Function`
    constructor; it grants nothing to an attacker who cannot get script running
    in the first place. `'self'` is deliberately NOT used — in a sandboxed
    document the origin is opaque, so `'self'` matches nothing and would block
    our own bundle.

    `img-src` stays default-deny (`data: blob:`) and is widened ONLY by hosts a
    repo names in malloy-config.json's `malloyyo.image_hosts`. Dashboards that
    build <img src> out of a model column need that, and a blanket `https:`
    would hand every dashboard on the server an exfil channel out through image
    URLs — `connect-src 'none'` closes the others. image-hosts.ts is the
    validator and the trust boundary; read it before touching this. */
export function frameCsp(nonce: string, imageHosts?: readonly string[]): string {
  // Re-validated HERE, not trusted from the caller: these strings come from a
  // repo's malloy-config.json by way of the DB, and this is where they enter a
  // response header. normalizeImageHosts re-emits each one from scratch, so
  // nothing an author wrote can append a directive of its own. See image-hosts.ts.
  const hosts = normalizeImageHosts(imageHosts);
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'unsafe-inline'",
    ["img-src data: blob:", ...hosts].join(" "),
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");
}

/** HTML-escape for both element text and a quoted attribute value. The quote
    escapes matter for the `src="…"` sinks below: without them an embedded `"`
    would close the attribute and let the rest be parsed as further attributes. */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function frameHtml(opts: {
  title: string;
  info: unknown;
  /** The sibling dashboards, nav order, this one excluded — `window.__DASHBOARDS__`.
      Model-derived (names and titles from the repo's own artifacts), so it is
      safe to inline through safeJson like the rest. */
  siblings?: unknown;
  givenSpecs: unknown;
  bundleUrl: string;
  nonce: string;
}): string {
  const { title, info, siblings, givenSpecs, bundleUrl, nonce } = opts;
  // Note what is NOT a parameter here: the givens and useUrlState values from
  // the query string. Those are the request-derived half, and they are read from
  // location.search by FRAME_BOOTSTRAP instead of being inlined — see the header.
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0"><div id="root"></div>` +
    `<script nonce="${nonce}">window.__DASHBOARD__=${safeJson(info)};` +
    `window.__DASHBOARDS__=${safeJson(siblings ?? [])};` +
    `window.__GIVENS__=${safeJson(givenSpecs)}</script>` +
    `<script nonce="${nonce}">${FRAME_BOOTSTRAP}</script>` +
    `<script nonce="${nonce}" src="/dashboard-vendor.js"></script>` +
    `<script nonce="${nonce}" src="${esc(bundleUrl)}"></script></body></html>`
  );
}

/** A fresh CSP nonce. Per-response and unpredictable, which is the whole
    contract: a nonce reused across responses is guessable by an attacker who
    can read one. */
export function frameNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}
