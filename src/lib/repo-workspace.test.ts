// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// "LINT BLESSED IT, THE SERVER REFUSED IT" — the defining bug of multi-dataset
// repos, and across three reviews almost every instance of it was the same
// shape: an in-memory file map on the server against a real directory tree on
// the author's machine.
//
// This file covers the two things that replaced that: the VIEW rule (pure, so
// one rule renders both the compile workspace and the stored file map) and the
// CONFIG walk (Malloy's own function, so there is nothing to keep in step).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layoutFromListing } from "@malloyyo/mcp-engine";
import {
  datasetView,
  discoverRepoConfig,
  fsLister,
  writeDatasetWorkspace,
  WorkspaceURLReader,
} from "./repo-workspace.js";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-ws-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const view = (paths: string[], dir: string, dirs: string[]) => {
  const r = datasetView(paths, dir, dirs);
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r.files;
};

// ── the view rule ───────────────────────────────────────────────────────────

test("a dataset's own directory becomes the model root", () => {
  // Everything downstream — the MCP query entry, dashboards, drafts, the
  // restricted-query gate — assumes a model is rooted at `index.malloy`.
  // Threading a per-dataset entry path through all of them would put a new
  // variable in the middle of the query path.
  const files = view(
    ["datasets/finance/index.malloy", "datasets/finance/dashboards/t.malloy"],
    "datasets/finance",
    ["datasets/finance"],
  );
  assert.deepEqual([...files.keys()].sort(), ["dashboards/t.malloy", "index.malloy"]);
  assert.equal(files.get("index.malloy"), "datasets/finance/index.malloy");
});

test("a shared lib/ keeps its repo-relative path, which is what ../../ resolves to", () => {
  // `import "../../lib/orders.malloy"` from the re-rooted entry resolves to
  // `file:///lib/orders.malloy`, because URL resolution clamps `..` at the root.
  const files = view(["datasets/finance/index.malloy", "lib/orders.malloy"], "datasets/finance", [
    "datasets/finance",
  ]);
  assert.equal(files.get("lib/orders.malloy"), "lib/orders.malloy");
});

test("a SIBLING dataset's directory is excluded", () => {
  // `datasets/sales/` is not this dataset's business, and a dashboard bundle
  // that inlined it would ship one dataset's model to another's readers.
  const files = view(
    ["datasets/finance/index.malloy", "datasets/sales/index.malloy", "datasets/sales/secret.malloy"],
    "datasets/finance",
    ["datasets/finance", "datasets/sales"],
  );
  assert.deepEqual([...files.keys()], ["index.malloy"]);
});

test("a single-dataset repo's view is the repo", () => {
  const files = view(["index.malloy", "dashboards/t.malloy", "lib/x.malloy"], "", []);
  assert.deepEqual([...files.keys()].sort(), ["dashboards/t.malloy", "index.malloy", "lib/x.malloy"]);
});

test("a path the dataset and the root both hold is REFUSED, because one would hide the other", () => {
  // `import "../../lib/x.malloy"` from inside the dataset reaches the ROOT's
  // lib; in the re-rooted view that path is the dataset's own. Guessing which
  // one the author meant publishes a model built from files they did not write.
  const r = datasetView(
    ["datasets/finance/index.malloy", "datasets/finance/lib/x.malloy", "lib/x.malloy"],
    "datasets/finance",
    ["datasets/finance"],
  );
  assert.ok("error" in r);
  assert.match(r.error, /lib\/x\.malloy: this dataset's directory and the repo root/);
});

test("malloy-config.json is NOT in the view — it is supplied by the config walk", () => {
  // Nearest-wins is the config's documented rule, and the collision refusal
  // above would call that an error. So it is excluded everywhere and handled in
  // exactly one place.
  const files = view(
    [
      "malloy-config.json",
      "malloy-config-local.json",
      "datasets/a/index.malloy",
      "datasets/a/malloy-config.json",
      "lib/x.malloy",
    ],
    "datasets/a",
    ["datasets/a"],
  );
  assert.deepEqual([...files.keys()].sort(), ["index.malloy", "lib/x.malloy"]);
});

// ── the config walk ─────────────────────────────────────────────────────────

test("the config walk checks EVERY intermediate directory, not two locations", async () => {
  // THE EXACT GOTCHA. The old server checked the repo root and the dataset's own
  // directory; Malloy's `discoverConfig` walks every level in between. So
  // `datasets/malloy-config.json` linted clean and failed on the server — under
  // a comment asserting the two could not disagree.
  //
  // This passes because the walk IS `discoverConfig`, called over the
  // materialized repo with the repo root as its ceiling, which is exactly how
  // the CLI's `makeRunner` calls it.
  const root = tree({
    "datasets/sales/index.malloy": "",
    "datasets/malloy-config.json": '{"connections":{"duckdb":{"is":"duckdb"}}}',
    "malloy-config.json": '{"connections":{"other":{"is":"duckdb"}}}',
  });
  const found = await discoverRepoConfig(root, "datasets/sales");
  assert.equal(found.from, "datasets/malloy-config.json", "the NEAREST one, at any depth");
  assert.match(found.text ?? "", /duckdb/);
});

test("…and nearest wins over the repo root", async () => {
  const root = tree({
    "datasets/sales/index.malloy": "",
    "datasets/sales/malloy-config.json": '{"connections":{"own":{"is":"duckdb"}}}',
    "malloy-config.json": '{"connections":{"shared":{"is":"duckdb"}}}',
  });
  const found = await discoverRepoConfig(root, "datasets/sales");
  assert.equal(found.from, "datasets/sales/malloy-config.json");
});

test("…and the repo root applies when the dataset has none of its own", async () => {
  const root = tree({
    "datasets/sales/index.malloy": "",
    "malloy-config.json": '{"connections":{"shared":{"is":"duckdb"}}}',
  });
  const found = await discoverRepoConfig(root, "datasets/sales");
  assert.equal(found.from, "malloy-config.json");
});

test("…and a repo with no config at all is not an error", async () => {
  const root = tree({ "index.malloy": "" });
  assert.deepEqual(await discoverRepoConfig(root, ""), {});
});

// ── the lister ──────────────────────────────────────────────────────────────

test("the lister FOLLOWS symlinks, which is the answer a compiler gets", () => {
  // The CLI's two readers disagreed on exactly this: its lister used
  // `Dirent.isDirectory()`, which does not follow, while its archive walker used
  // `statSync`, which does — so a repo that symlinked a dataset directory linted
  // as empty and published two datasets.
  const root = tree({ "real/sales/index.malloy": "source: s is 1\n" });
  fs.mkdirSync(path.join(root, "datasets"));
  fs.symlinkSync(path.join(root, "real/sales"), path.join(root, "datasets/sales"), "dir");
  const list = fsLister(root);
  return (async () => {
    const entries = await list("datasets");
    assert.deepEqual(entries, [{ name: "sales", path: "datasets/sales", type: "dir" }]);
    // And the layout rules, over that lister, see a dataset.
    const layout = await layoutFromListing(list, "test");
    assert.ok(layout.ok, layout.ok ? "" : layout.error);
    assert.equal(layout.kind, "multi");
    assert.deepEqual(layout.kind === "multi" ? layout.datasets : [], [
      { name: "sales", dir: "datasets/sales" },
    ]);
  })();
});

test("…and a BROKEN symlink is neither a file nor a directory, rather than a crash", async () => {
  const root = tree({ "index.malloy": "" });
  fs.symlinkSync(path.join(root, "nope"), path.join(root, "dangling"));
  const entries = await fsLister(root)("");
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ["index.malloy"],
  );
});

test("an EMPTY index.malloy still makes a dataset exist", async () => {
  // The layout rules key on a file EXISTING, not on its contents, and an
  // extractor that dropped zero-length members made `touch index.malloy` delete
  // a dataset as far as the server was concerned.
  const root = tree({ "datasets/finance/index.malloy": "", "datasets/sales/index.malloy": "x" });
  const layout = await layoutFromListing(fsLister(root), "test");
  assert.ok(layout.ok, layout.ok ? "" : layout.error);
  assert.deepEqual(
    (layout.kind === "multi" ? layout.datasets : []).map((d) => d.name),
    ["finance", "sales"],
  );
});

// ── the workspace on disk ───────────────────────────────────────────────────

test("the workspace is a real directory the compiler reads with nothing but a path", async () => {
  const root = tree({
    "datasets/finance/index.malloy": 'import "../../lib/orders.malloy"\n',
    "datasets/finance/dashboards/t.malloy": "// dash\n",
    "datasets/sales/index.malloy": "// sibling\n",
    "lib/orders.malloy": "source: orders is 1\n",
    "malloy-config.json": '{"connections":{"duckdb":{"is":"duckdb"}}}',
  });
  const v = datasetView(
    [
      "datasets/finance/index.malloy",
      "datasets/finance/dashboards/t.malloy",
      "datasets/sales/index.malloy",
      "lib/orders.malloy",
      "malloy-config.json",
    ],
    "datasets/finance",
    ["datasets/finance", "datasets/sales"],
  );
  assert.ok(!("error" in v));
  const config = await discoverRepoConfig(root, "datasets/finance");
  const ws = writeDatasetWorkspace(root, v, config);

  assert.equal(fs.readFileSync(path.join(ws, "index.malloy"), "utf8"), 'import "../../lib/orders.malloy"\n');
  assert.ok(fs.existsSync(path.join(ws, "lib/orders.malloy")), "the shared lib is at its repo path");
  assert.ok(fs.existsSync(path.join(ws, "dashboards/t.malloy")));
  assert.ok(fs.existsSync(path.join(ws, "malloy-config.json")), "and the discovered config is at the root");
  assert.equal(fs.existsSync(path.join(ws, "datasets")), false, "the sibling is not here");

  // The reader resolves `../../lib/x` the way Malloy will: URL `..` clamps at
  // the root, so it lands on the repo-relative path the workspace preserved.
  const reader = new WorkspaceURLReader(ws);
  const text = await reader.readURL(new URL("file:///index.malloy").toString() === "" ? new URL("file:///index.malloy") : new URL("lib/orders.malloy", "file:///datasets/../../"));
  assert.equal(text, "source: orders is 1\n");
  assert.deepEqual([...reader.fetched.keys()], ["lib/orders.malloy"], "and records what it read");
});

test("a path that climbs out of the workspace cannot be expressed", async () => {
  // URL resolution CLAMPS `..` at the root, which is the property the whole
  // re-rooting design rests on: `import "../../lib/x.malloy"` from the
  // re-rooted entry lands on `file:///lib/x.malloy`, never above it. So the
  // reader's own guard is belt-and-braces for a URL built some other way.
  assert.equal(new URL("file:///../../etc/passwd").pathname, "/etc/passwd");
  const root = tree({ "etc/passwd": "fixture, not the real one" });
  const reader = new WorkspaceURLReader(root);
  assert.equal(await reader.readURL(new URL("file:///../../etc/passwd")), "fixture, not the real one");

  // And the guard still refuses a `..` that survives, so it cannot be removed
  // on the grounds that nothing reaches it.
  await assert.rejects(
    () => reader.readURL({ pathname: "/a/../../b" } as unknown as URL),
    /outside the model root/,
  );
});
