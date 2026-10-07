// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Every "open this in Claude" button that knows the connector isn't linked must
// show the setup steps (ClaudeConnectDialog), not open claude.ai's Connectors
// page bare. That page has no entry for this instance and nothing on it says
// the address to add is this origin + `/mcp`, so a first-time user lands there
// with no way forward. Source-reading, in the same spirit as
// ltool-ask-ui.test.ts: the alternative is a browser harness for one branch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SURFACES: Array<[string, string]> = [
  ["dataset toolbar (Explore in Claude)", "../components/DatasetNav.tsx"],
  ["AI Q&A page (Ask your own in Claude)", "../app/datasets/[id]/questions/page.tsx"],
];

for (const [label, rel] of SURFACES) {
  test(`${label}: an unlinked user gets the setup dialog`, () => {
    const src = read(rel);
    assert.match(src, /<ClaudeConnectDialog\b/, `${rel} must render ClaudeConnectDialog`);
    assert.doesNotMatch(
      src,
      /:\s*"https:\/\/claude\.ai\/customize\/connectors"/,
      `${rel} must not fall back to opening claude.ai's Connectors page with no instructions`,
    );
  });
}

test("the setup dialog gives the /mcp address, not the bare origin", () => {
  const src = read("../components/ClaudeConnectDialog.tsx");
  assert.match(src, /`\$\{origin\}\/mcp`/, "the connector URL is the instance origin + /mcp");
  assert.match(src, /<CopyChip value=\{mcpUrl\}/, "the /mcp URL must be copyable");
});
