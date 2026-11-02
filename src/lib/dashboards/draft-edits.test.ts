// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Find/replace edits to a saved draft: a small change sends the changed text,
// not the whole file. Any failing edit changes nothing and names itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDraftEdits } from "./draft-text";

const FILES = {
  source: `export default function D() {\n  return <h1>Sales</h1>;\n}\n`,
  malloy: `import "../index.malloy"\n# artifact { name=d title="Sales" }\nquery: d is sales -> { aggregate: total }\n`,
};

test("edits apply in order, to the file each names", () => {
  const r = applyDraftEdits(FILES, [
    { find: "<h1>Sales</h1>", replace: "<h1>Revenue</h1>" },
    { find: "Revenue", replace: "Revenue by month" },
    { find: `title="Sales"`, replace: `title="Revenue"`, file: "malloy" },
  ]);
  assert.ok(r.ok);
  assert.match(r.source, /<h1>Revenue by month<\/h1>/);
  assert.match(r.malloy, /title="Revenue"/);

  // The file no edit names comes back as it was.
  const one = applyDraftEdits(FILES, [{ find: "Sales", replace: "Revenue" }]);
  assert.ok(one.ok && one.malloy === FILES.malloy);
});

test("replace text is literal, not a pattern", () => {
  const r = applyDraftEdits(FILES, [{ find: "Sales", replace: "$& $1" }]);
  assert.ok(r.ok && r.source.includes("<h1>$& $1</h1>"));
});

test("an edit that is missing, empty, ambiguous or malformed fails the whole call", () => {
  const missing = applyDraftEdits(FILES, [
    { find: "Sales", replace: "Revenue" },
    { find: "<h2>", replace: "" },
  ]);
  assert.deepEqual(missing, { ok: false, error: "edit 2: 'find' is not in the draft's source; nothing was saved" });

  const empty = applyDraftEdits(FILES, [{ find: "", replace: "x" }]);
  assert.deepEqual(empty, { ok: false, error: "edit 1: 'find' is empty; nothing was saved" });

  const twice = applyDraftEdits({ ...FILES, source: "a a" }, [{ find: "a", replace: "b" }]);
  assert.ok(!twice.ok && /matches more than once in the draft's source/.test(twice.error));

  const badFile = applyDraftEdits(FILES, [{ find: "Sales", replace: "x", file: "Malloy" as "malloy" }]);
  assert.deepEqual(badFile, { ok: false, error: "edit 1: 'file' must be source or malloy; nothing was saved" });

  const notObject = applyDraftEdits(FILES, [null as unknown as { find: string; replace: string }]);
  assert.deepEqual(notObject, { ok: false, error: "edit 1: expected { find, replace } strings; nothing was saved" });
});
