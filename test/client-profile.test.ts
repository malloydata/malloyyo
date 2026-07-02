// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Pure unit tests for the client presentation profile (no DB, no HTTP).
// Run via `npx tsx --test test/client-profile.test.ts` (folded into
// scripts/hosted-test.sh so it rides the preflight gate).

import test from "node:test";
import assert from "node:assert/strict";
import { clientProfile, renderRowsMarkdown, MAX_TABLE_ROWS } from "@/lib/client-profile";

test("clientProfile detects ChatGPT (openai-mcp UA) and defaults everything else", () => {
  assert.equal(clientProfile("openai-mcp/1.0.0").id, "chatgpt");
  assert.equal(clientProfile("openai-mcp/1.0.0").renderRowsInline, true);
  // ChatGPT files structuredContent away, so it must not receive it.
  assert.equal(clientProfile("openai-mcp/1.0.0").sendStructuredContent, false);
  // Case-insensitive, version-agnostic.
  assert.equal(clientProfile("OpenAI-MCP/2.3.4").id, "chatgpt");

  for (const ua of ["Claude-User", "Mozilla/5.0 ...", "curl/7.88.1", "", null, undefined]) {
    const p = clientProfile(ua);
    assert.equal(p.id, "default", `UA ${JSON.stringify(ua)} → default`);
    assert.equal(p.renderRowsInline, false);
    assert.equal(p.sendStructuredContent, true, "default client keeps structuredContent");
  }
  // Must not match a substring in the middle of some other UA.
  assert.equal(clientProfile("something-openai-mcp").id, "default");
});

test("renderRowsMarkdown builds a table for flat rows, with footer + link", () => {
  const md = renderRowsMarkdown({
    rows: [
      { name: "James", c: 7409 },
      { name: "Leslie", c: 7407 },
    ],
    row_count: 2,
    ltool_link: { text: "↗ Malloyyo", url: "https://x/ltool/main_abc" },
  });
  assert.match(md, /\| name \| c \|/, "header row");
  assert.match(md, /\| --- \| --- \|/, "divider row");
  assert.match(md, /\| James \| 7409 \|/, "data row 1");
  assert.match(md, /\| Leslie \| 7407 \|/, "data row 2");
  assert.match(md, /_2 rows\._/, "row-count footer");
  assert.match(md, /\[↗ Malloyyo\]\(https:\/\/x\/ltool\/main_abc\)/, "share link");
});

test("renderRowsMarkdown caps rows and reports the true total", () => {
  const rows = Array.from({ length: MAX_TABLE_ROWS + 25 }, (_, i) => ({ i }));
  const md = renderRowsMarkdown({ rows, row_count: rows.length });
  const dataRows = md.split("\n").filter((l) => /^\| \d+ \|$/.test(l));
  assert.equal(dataRows.length, MAX_TABLE_ROWS, "table is capped");
  assert.match(md, new RegExp(`Showing ${MAX_TABLE_ROWS} of ${rows.length} rows\\.`));
});

test("renderRowsMarkdown surfaces a truncation hint when present", () => {
  const md = renderRowsMarkdown({
    rows: [{ a: 1 }],
    row_count: 1,
    truncated: { hint: "Result hit the row limit; more rows may exist." },
  });
  assert.match(md, /more rows may exist/);
});

test("renderRowsMarkdown escapes pipes and newlines in cells", () => {
  const md = renderRowsMarkdown({ rows: [{ v: "a|b\nc" }], row_count: 1 });
  assert.match(md, /\| a\\\|b c \|/, "pipe escaped, newline flattened");
});

test("renderRowsMarkdown falls back to compact JSON for nested rows", () => {
  const payload = {
    rows: [{ carrier: "AA", by_month: [{ m: 1, n: 3 }] }],
    row_count: 1,
    ltool_link: { text: "↗ Malloyyo", url: "https://x/ltool/main_abc" },
  };
  const md = renderRowsMarkdown(payload);
  assert.ok(!md.includes("| carrier |"), "no table for nested rows");
  assert.ok(md.includes(JSON.stringify(payload)), "compact JSON payload is present");
  assert.match(md, /\[↗ Malloyyo\]\(https:\/\/x\/ltool\/main_abc\)/, "link still appended");
  assert.ok(!md.includes("\n  "), "compact (not pretty-printed)");
});

test("renderRowsMarkdown falls back to compact JSON for an empty result", () => {
  const md = renderRowsMarkdown({ rows: [], row_count: 0 });
  assert.ok(md.startsWith("{"), "compact JSON, no empty table");
});
