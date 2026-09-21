// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// The panel is a SHELL: markup and a loader that pull the runtime and the
// ext-apps SDK from this instance's origin. It used to inline both, which made
// `resources/read` a ~5 MB JSON-RPC message — over Vercel's function-response
// limit, and past what a host will accept, so the panel never loaded at all
// ("Unable to reach <instance>"). The size assertion below is the regression
// test for that: it is not a style preference.

import test from "node:test";
import assert from "node:assert/strict";
import { dashboardPanel } from "./mcp-app-panel";

test("the panel is a small shell that loads its scripts from the instance", () => {
  const panel = dashboardPanel("https://example.test");

  assert.ok(
    panel.html.length < 64 * 1024,
    `panel is ${panel.html.length} bytes — it must stay markup, not inline the runtime`,
  );
  assert.match(panel.html, /<script src="https:\/\/example\.test\/mcp-app-sdk\.js"><\/script>/);
  assert.match(panel.html, /<script src="https:\/\/example\.test\/dashboard-vendor\.js"><\/script>/);
  assert.match(panel.uri, /^ui:\/\/dashboard\/panel-[0-9a-f]{12}\.html$/);
});

test("one URI per origin, stable across calls", () => {
  assert.equal(dashboardPanel("https://a.test").uri, dashboardPanel("https://a.test").uri);
  // The origin is baked into the markup, so two instances cannot share a URI —
  // a host that cached one must not serve b.test a panel pointing at a.test.
  assert.notEqual(dashboardPanel("https://a.test").uri, dashboardPanel("https://b.test").uri);
});

test("a trailing slash on the origin doesn't double up in the script URLs", () => {
  assert.match(dashboardPanel("https://c.test/").html, /src="https:\/\/c\.test\/dashboard-vendor\.js"/);
});
