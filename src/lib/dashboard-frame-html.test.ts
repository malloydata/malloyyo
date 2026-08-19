// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Regression tests for the dashboard frame document's XSS fix.
//
// The bug: the frame route inlined every query parameter into an inline
// <script> with a bare JSON.stringify. Script content is raw text terminated by
// `</script`, so `?x=</script><script>alert(1)</script>` broke out of the block
// and ran same-origin — the route is a plain GET under /api/, reachable as a
// top-level navigation where the embedder's iframe sandbox does not apply.
//
// The fix has two layers and these tests pin both, because each is the kind of
// thing a later "tidy-up" removes without noticing:
//
//  1. Request-derived state is not in the document AT ALL. The frame's own URL
//     already carries the query string, so FRAME_BOOTSTRAP parses
//     location.search client-side. No reflection, nothing to escape.
//  2. Model-derived values that ARE inlined (title, info, given specs) go
//     through safeJson()/esc(), and the response carries a nonce-only CSP.
//
// runBootstrap() below actually EXECUTES the bootstrap against a stub window so
// the parsing contract is tested, not just asserted about.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_BOOTSTRAP,
  frameCsp,
  frameHtml,
  frameNonce,
  safeJson,
} from "./dashboards/frame-html.js";

const BREAKOUT = "</script><script>alert(1)</script>";

/** Execute FRAME_BOOTSTRAP as the browser would, against a stub window. */
function runBootstrap(search: string, specs: unknown[] = [{ name: "YEAR" }, { name: "state" }]) {
  const win: Record<string, unknown> = { __GIVENS__: specs };
  new Function("window", "location", "URLSearchParams", FRAME_BOOTSTRAP)(
    win,
    { search },
    URLSearchParams,
  );
  return {
    givens: win.__INITIAL_GIVENS__ as Record<string, string>,
    urlState: win.__INITIAL_URLSTATE__ as Record<string, string>,
  };
}

test("safeJson escapes angle brackets so a script block cannot be closed", () => {
  const out = safeJson({ q: BREAKOUT });
  assert.equal(out.includes("</script"), false);
  assert.equal(out.includes("<"), false);
  assert.equal(out.includes(">"), false);
  assert.equal(out, '{"q":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}');
});

test("safeJson escapes the JS line terminators that are legal raw in JSON", () => {
  const out = safeJson({ a: "x\u2028y\u2029z" });
  assert.equal(out.includes("\u2028"), false);
  assert.equal(out.includes("\u2029"), false);
  assert.equal(out, '{"a":"x\\u2028y\\u2029z"}');
});

test("safeJson output still parses back to the original value", () => {
  for (const v of [
    { q: BREAKOUT },
    { a: "x\u2028y\u2029z" },
    { nested: [{ "<key>": "</script>" }], n: 1, b: true, z: null },
    [1, "<", ">", "\u2028"],
  ]) {
    assert.deepEqual(JSON.parse(safeJson(v)), v);
  }
});

test("frameHtml emits no attacker-controlled markup, whatever the model says", () => {
  const html = frameHtml({
    title: BREAKOUT,
    info: { name: BREAKOUT, title: BREAKOUT },
    givenSpecs: [{ name: "YEAR", type: "filter<number>", description: BREAKOUT }],
    bundleUrl: "/api/dashboards/d/n/bundle?t=tok",
    nonce: "NONCE",
  });
  // Exactly the four script elements we emit — a breakout would add more.
  assert.equal(html.match(/<script/g)?.length, 4);
  assert.equal(html.match(/<\/script>/g)?.length, 4);
  // Every one carries the nonce, so the CSP admits ours and only ours.
  assert.equal(html.match(/<script nonce="NONCE"/g)?.length, 4);
  // The payload survives as data (it must — the runtime reads it), but only in
  // escaped form: no raw markup anywhere.
  assert.equal(html.includes("<script>alert(1)"), false);
  assert.equal(html.includes("\\u003cscript\\u003ealert(1)"), true);
  // The title goes through HTML escaping, not JSON escaping.
  assert.equal(html.includes("<title>&lt;/script&gt;"), true);
});

test("frameHtml never reflects the request: no query state is a parameter at all", () => {
  // The regression this guards: someone "helpfully" re-adds initialGivens /
  // initialUrlState as frameHtml options and we are back to a reflected sink.
  // The signature takes only model-derived values, so a crafted link cannot
  // reach the document — the bootstrap reads location.search in the browser.
  const html = frameHtml({
    title: "t",
    info: {},
    givenSpecs: [{ name: "YEAR" }],
    bundleUrl: "/api/dashboards/d/n/bundle?t=tok",
    nonce: "NONCE",
  });
  assert.equal(html.includes("__INITIAL_GIVENS__=") , false);
  assert.equal(html.includes("__INITIAL_URLSTATE__="), false);
  // They are still SET — by the constant bootstrap, from location.search.
  assert.equal(html.includes("window.__INITIAL_GIVENS__ = givens"), true);
  assert.equal(html.includes("window.__INITIAL_URLSTATE__ = urlState"), true);
});

test("the bootstrap is a constant with no interpolation", () => {
  // The one property that makes this safe. A `${` in the emitted text would mean
  // someone turned it back into a template with request data in it.
  assert.equal(FRAME_BOOTSTRAP.includes("${"), false);
  // And it must not be able to close its own script element.
  assert.equal(FRAME_BOOTSTRAP.includes("</script"), false);
});

test("bootstrap: keeps declared $-givens, case-insensitively, prefix intact", () => {
  const { givens } = runBootstrap("?$year=2020&$STATE=CA");
  // Keys keep their `$` prefix — the runtime requires it (runtime.tsx strips it).
  assert.deepEqual(givens, { $year: "2020", $STATE: "CA" });
});

test("bootstrap: drops undeclared and unprefixed params", () => {
  const { givens, urlState } = runBootstrap(
    `?$YEAR=2020&$nope=${encodeURIComponent(BREAKOUT)}&YEAR=2021&d=dash&x=1`,
    [{ name: "YEAR" }],
  );
  assert.deepEqual(givens, { $YEAR: "2020" });
  assert.deepEqual(urlState, {});
});

test("bootstrap: keeps the `~` view-state namespace, unfiltered by design", () => {
  const { givens, urlState } = runBootstrap("?~rack=AEINRST&~board=%5B%5B1%2C2%5D%5D&$YEAR=2020");
  // Unbounded on purpose: these keys are invented by the component author, so
  // there is nothing to allow-list against. Safe because it is never reflected.
  assert.deepEqual(urlState, { "~rack": "AEINRST", "~board": "[[1,2]]" });
  assert.deepEqual(givens, { $YEAR: "2020" });
});

test("bootstrap: a breakout payload in a `~` param stays inert data", () => {
  // The exact attack that used to work. It now never touches the document — it
  // is parsed from location.search into a JS value in the browser.
  const { urlState } = runBootstrap(`?~evil=${encodeURIComponent(BREAKOUT)}`);
  assert.deepEqual(urlState, { "~evil": BREAKOUT });
  const html = frameHtml({
    title: "t",
    info: {},
    givenSpecs: [],
    bundleUrl: "/b",
    nonce: "N",
  });
  assert.equal(html.includes("alert(1)"), false);
});

test("bootstrap: a malformed given spec declares nothing (fails closed)", () => {
  const { givens } = runBootstrap("?$YEAR=2020", [null, {}, { name: 42 }]);
  assert.deepEqual(givens, {});
});



test("the CSP sandboxes the response itself and admits only nonced scripts", () => {
  const csp = frameCsp("NONCE");
  assert.match(csp, /(^|; )default-src 'none'(;|$)/);
  // Containment is a property of the response, not of the embedding page.
  assert.match(csp, /(^|; )sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox(;|$)/);
  // Nonce-only: no 'self', no 'unsafe-inline'. ('self' would match nothing in a
  // sandboxed document's opaque origin anyway.)
  assert.match(csp, /script-src 'nonce-NONCE' 'unsafe-eval'/);
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false);
});

test("frameNonce is fresh per call", () => {
  const seen = new Set(Array.from({ length: 50 }, () => frameNonce()));
  assert.equal(seen.size, 50);
});
