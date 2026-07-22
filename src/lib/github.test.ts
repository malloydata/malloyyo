// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Pure unit tests for GitHub path handling (github_path subdirectory support).
// No network: global fetch is stubbed. Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGitHubPath, joinRepoPath, GitHubURLReader } from "./github";

test("normalizeGitHubPath strips whitespace and slashes", () => {
  assert.equal(normalizeGitHubPath(""), "");
  assert.equal(normalizeGitHubPath(null), "");
  assert.equal(normalizeGitHubPath(undefined), "");
  assert.equal(normalizeGitHubPath("malloy"), "malloy");
  assert.equal(normalizeGitHubPath("malloy/"), "malloy");
  assert.equal(normalizeGitHubPath("/malloy"), "malloy");
  assert.equal(normalizeGitHubPath(" /a/b/ "), "a/b");
});

test("joinRepoPath joins only when a base is set", () => {
  assert.equal(joinRepoPath("", "index.malloy"), "index.malloy");
  assert.equal(joinRepoPath("malloy", "index.malloy"), "malloy/index.malloy");
  assert.equal(joinRepoPath("a/b", "dashboards/x.malloy"), "a/b/dashboards/x.malloy");
});

/** Stub global fetch, capture requested URLs, return fixed content. */
function withFetchStub(fn: (urls: string[]) => Promise<void>): Promise<void> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("model content", { status: 200 });
  }) as typeof fetch;
  return fn(urls).finally(() => {
    globalThis.fetch = original;
  });
}

test("GitHubURLReader prefixes fetches with basePath but caches model-relative keys", () =>
  withFetchStub(async (urls) => {
    const reader = new GitHubURLReader("owner", "repo", "main", false, "malloy");
    const content = await reader.readURL(new URL("file:///index.malloy"));
    assert.equal(content, "model content");
    assert.equal(urls.length, 1);
    assert.ok(
      urls[0].includes("/repos/owner/repo/contents/malloy/index.malloy?ref=main"),
      `expected prefixed contents URL, got ${urls[0]}`,
    );
    // Cache key stays model-relative — storage and import resolution are
    // independent of where the model sits in the repo.
    assert.ok(reader.fetched.has("index.malloy"));
    assert.ok(!reader.fetched.has("malloy/index.malloy"));
    // Second read hits the cache, no new fetch.
    await reader.readURL(new URL("file:///index.malloy"));
    assert.equal(urls.length, 1);
  }));

test("GitHubURLReader without basePath fetches from the repo root (unchanged behavior)", () =>
  withFetchStub(async (urls) => {
    const reader = new GitHubURLReader("owner", "repo", "main", false);
    await reader.readURL(new URL("file:///dashboards/sales.malloy"));
    assert.ok(
      urls[0].includes("/repos/owner/repo/contents/dashboards/sales.malloy?ref=main"),
      `expected root contents URL, got ${urls[0]}`,
    );
    assert.ok(reader.fetched.has("dashboards/sales.malloy"));
  }));
