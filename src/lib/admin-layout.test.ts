// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The admin frame is a flex item inside the root layout's column. Horizontal auto
// margins disable cross-axis stretching, so an auto width follows whichever streamed
// child is currently rendered: a short loading message makes the tab rail narrow, then
// the loaded table makes it jump wider. Pin the explicit width that keeps the shared
// layout stable across that transition.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const layout = readFileSync(new URL("../app/admin/layout.tsx", import.meta.url), "utf8");

test("the admin frame width does not depend on streamed page content", () => {
  const classes = layout.match(/<main className="([^"]+)"/)?.[1].split(/\s+/) ?? [];

  assert.ok(classes.includes("w-full"), "the centered flex item must have an explicit width");
  assert.ok(classes.includes("max-w-3xl"), "the explicit width must retain the admin cap");
});
