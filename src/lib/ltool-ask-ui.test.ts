// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Two invariants of the ltool Ask UI that are easy to regress by tidying, and
// whose failure is invisible to the person doing the tidying. Source-reading
// tests, in the same spirit as admin-layout.test.ts: the alternative is a
// browser harness for two conditions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../components/LtoolApp.tsx", import.meta.url), "utf8");

test("Enter does not submit a question while an IME is composing", () => {
  const handler = app.match(/onKeyDown=\{\(e\) => \{[\s\S]*?\}\}/)?.[0] ?? "";

  assert.match(
    handler,
    /isComposing/,
    "confirming a Japanese/Chinese/Korean IME candidate is also an Enter — without " +
      "this guard it submits half-converted text and bills for the answer",
  );
  // The guard has to come first: a `return` after preventDefault/onSubmit would
  // be decoration.
  assert.ok(
    handler.indexOf("isComposing") < handler.indexOf("onSubmit"),
    "the composition check must precede the submit, not follow it",
  );
});

test("the source picker is only offered where picking one leads somewhere", () => {
  // Without Ask, choosing a source lands on "select a query from the sidebar" —
  // an invitation followed by a refusal. The picker is gated on Ask for that
  // reason, and the gate is easy to drop while rearranging the branches.
  assert.match(
    app,
    /askAvailable && !sourceFilter \? \(\s*<SourcePicker/,
    "SourcePicker must be gated on askAvailable, not shown whenever no source is set",
  );
});
