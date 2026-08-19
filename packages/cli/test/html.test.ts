// The `<script>` embedding contract, pinned.
//
// Three CLI shells (the dev server's in-page and parent/frame documents, and
// every bundled static page) inline JSON into an inline <script>. They used
// bare `JSON.stringify`, which does NOT make a value safe there: script content
// is raw text terminated by `</script`, so a title or given value containing
// `</script><script>…` closes the block and the remainder is parsed as HTML.
// The hosted app had the same bug as a reflected XSS; these tests keep the CLI
// half from regressing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeJson } from "../src/shared/html.js";

test("safeJson makes a script block impossible to terminate", () => {
  const out = safeJson({ title: "</script><script>alert(1)</script>" });
  assert.equal(out.includes("</script"), false);
  assert.equal(out.includes("<"), false);
  assert.equal(out.includes(">"), false);
});

test("safeJson escapes U+2028/U+2029, which are line terminators in JS source", () => {
  const out = safeJson("a\u2028b\u2029c");
  assert.equal(out, '"a\\u2028b\\u2029c"');
});

test("safeJson round-trips: the escapes are inside string literals only", () => {
  const value = { a: "</script>", b: ["<", ">", "\u2028"], c: 1, d: null };
  assert.deepEqual(JSON.parse(safeJson(value)), value);
});
