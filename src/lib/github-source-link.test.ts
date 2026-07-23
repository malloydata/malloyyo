// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Run: npm test   (tsx --test src/lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoSlug, dashboardSourcePath, dashboardSourceUrl, repoUrl } from "./github-source-link";

test("parseRepoSlug accepts the shapes a repo is actually stored in", () => {
  assert.equal(parseRepoSlug("malloydata/malloyyo-ecommerce"), "malloydata/malloyyo-ecommerce");
  assert.equal(parseRepoSlug("https://github.com/malloydata/malloyyo-ecommerce"), "malloydata/malloyyo-ecommerce");
  assert.equal(parseRepoSlug("https://github.com/malloydata/malloyyo-ecommerce.git"), "malloydata/malloyyo-ecommerce");
  assert.equal(parseRepoSlug("git@github.com:malloydata/malloyyo-ecommerce.git"), "malloydata/malloyyo-ecommerce");
  assert.equal(parseRepoSlug("  malloydata/malloyyo-ecommerce  "), "malloydata/malloyyo-ecommerce");
});

test("parseRepoSlug rejects what it can't turn into a github repo", () => {
  for (const bad of [null, undefined, "", "   ", "malloydata", "a/b/c", "https://gitlab.com/a/b"]) {
    assert.equal(parseRepoSlug(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("dashboardSourcePath finds the file rather than assuming the layout", () => {
  const files = [
    { path: "index.malloy" },
    { path: "ecommerce.malloy" },
    { path: "dashboards/seasonality.malloy" },
  ];
  assert.equal(dashboardSourcePath("seasonality", files), "dashboards/seasonality.malloy");
  // Present but somewhere else — follow the file list, don't guess the convention.
  assert.equal(dashboardSourcePath("odd", [{ path: "custom/dir/odd.malloy" }]), "custom/dir/odd.malloy");
  // A v1 dashboard declared inside index.malloy has no file of its own: no link
  // beats a link to a 404.
  assert.equal(dashboardSourcePath("inline_one", files), null);
  // No file list at all → the v2 convention is the only guess available.
  assert.equal(dashboardSourcePath("overview", null), "dashboards/overview.malloy");
});

test("dashboardSourceUrl prefers the published sha", () => {
  const url = dashboardSourceUrl({
    name: "seasonality",
    gitRepo: "malloydata/malloyyo-ecommerce",
    gitBranch: "main",
    gitSha: "a1b2c3d4e5f6",
    files: [{ path: "dashboards/seasonality.malloy" }],
  });
  assert.equal(
    url,
    "https://github.com/malloydata/malloyyo-ecommerce/blob/a1b2c3d4e5f6/dashboards/seasonality.malloy",
  );
});

test("dashboardSourceUrl falls back to a branch when the publish was dirty", () => {
  // The sha exists, but the published files differ from it — the branch is the
  // more honest target.
  const url = dashboardSourceUrl({
    name: "seasonality",
    gitRepo: "malloydata/malloyyo-ecommerce",
    gitBranch: "feature-x",
    gitSha: "a1b2c3d4e5f6",
    gitDirty: true,
    files: [{ path: "dashboards/seasonality.malloy" }],
  });
  assert.match(url!, /\/blob\/feature-x\//);
});

test("dashboardSourceUrl uses the dataset's repo when there is no push provenance", () => {
  // The GitHub-pull path: this is what the live `ecommerce` dataset looks like.
  const url = dashboardSourceUrl({
    name: "product_explorer_dashboard",
    datasetRepo: "malloydata/malloyyo-ecommerce",
    datasetBranch: "main",
    files: [{ path: "dashboards/product_explorer_dashboard.malloy" }],
  });
  assert.equal(
    url,
    "https://github.com/malloydata/malloyyo-ecommerce/blob/main/dashboards/product_explorer_dashboard.malloy",
  );
});

test("dashboardSourceUrl defaults the ref to main when no branch is recorded", () => {
  const url = dashboardSourceUrl({
    name: "d",
    datasetRepo: "o/r",
    files: [{ path: "dashboards/d.malloy" }],
  });
  assert.match(url!, /\/blob\/main\/dashboards\/d\.malloy$/);
});

test("dashboardSourceUrl returns null when there is nothing to link to", () => {
  assert.equal(dashboardSourceUrl({ name: "d", files: [{ path: "dashboards/d.malloy" }] }), null);
  assert.equal(
    dashboardSourceUrl({ name: "missing", datasetRepo: "o/r", files: [{ path: "index.malloy" }] }),
    null,
  );
});

test("paths and refs are URL-encoded", () => {
  const url = dashboardSourceUrl({
    name: "d",
    datasetRepo: "o/r",
    datasetBranch: "feature/my branch",
    files: [{ path: "dash boards/d.malloy" }],
  });
  assert.equal(url, "https://github.com/o/r/blob/feature%2Fmy%20branch/dash%20boards/d.malloy");
});

test("repoUrl", () => {
  assert.equal(repoUrl({ datasetRepo: "o/r" }), "https://github.com/o/r");
  assert.equal(repoUrl({ gitRepo: "https://github.com/a/b.git", datasetRepo: "o/r" }), "https://github.com/a/b");
  assert.equal(repoUrl({}), null);
});
