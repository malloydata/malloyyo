// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// The panel's assets are read off disk (the frame runtime and the ext-apps
// SDK). When they can't be, dashboardPanel() must return null — /mcp then
// drops only the dashboard tools — rather than throw from the per-request
// server factory and take every /mcp tool down with it.
//
// Its own file: the panel is cached per process, so the failure has to be the
// first build this module ever attempts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dashboardPanel } from "./mcp-app-panel";

test("missing panel assets → null (not a throw), and the failure is remembered", () => {
  const cwd = process.cwd();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-panel-"));
  process.chdir(empty);
  try {
    assert.equal(dashboardPanel(), null);
  } finally {
    process.chdir(cwd);
    fs.rmSync(empty, { recursive: true, force: true });
  }
  // Back in the repo the files exist, but a deployment's missing asset won't
  // appear later either — the failure sticks rather than rereading per request.
  assert.equal(dashboardPanel(), null);
});
