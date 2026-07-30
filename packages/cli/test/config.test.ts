// The `malloyyo` block in malloy-config.json holds publish TARGETS keyed by
// name, and now also plain settings like `analytics`. These tests pin the rule
// that keeps those from colliding: a target is recognised by SHAPE (an object
// with a string `url`), not by "every key in the block". Without that, a
// setting would show up as an available publish destination and would break the
// one-unambiguous-target rule in resolveInstance.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSiteConfig, resolveTarget, resolveInstance } from "../src/config.js";

function withConfig(malloyyo: unknown, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-cfg-"));
  fs.writeFileSync(path.join(dir, "malloy-config.json"), JSON.stringify({ malloyyo }));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("new format: analytics and targets are both known keys", () => {
  withConfig(
    { analytics: "G-ABC123", targets: { prod: { url: "https://x.dev", dataset: "d" } } },
    (dir) => {
      assert.deepEqual(readSiteConfig(dir), { analytics: "G-ABC123" });
      assert.equal(resolveTarget(dir, "prod").dataset, "d");
      // One target, so an omitted target name stays unambiguous.
      assert.equal(resolveInstance(dir).url, "https://x.dev");
      assert.throws(() => resolveTarget(dir, "analytics"), /Unknown target/);
    },
  );
});

test("legacy format: top-level targets still resolve", () => {
  // The old shape put targets directly in the block. Accepted, with a warning.
  withConfig({ localhost: { url: "https://old.dev", dataset: "d" } }, (dir) => {
    assert.equal(resolveTarget(dir, "localhost").url, "https://old.dev");
    assert.equal(resolveInstance(dir).url, "https://old.dev");
  });
});

test("legacy and new targets coexist", () => {
  withConfig(
    {
      analytics: "G-ABC123",
      targets: { prod: { url: "https://new.dev", dataset: "n" } },
      old: { url: "https://old.dev", dataset: "o" },
    },
    (dir) => {
      assert.equal(resolveTarget(dir, "prod").dataset, "n");
      assert.equal(resolveTarget(dir, "old").dataset, "o");
      assert.deepEqual(readSiteConfig(dir), { analytics: "G-ABC123" });
    },
  );
});

test("an unknown key is ignored, not treated as a target", () => {
  // A typo used to become a publish destination. Now it is dropped and warned.
  withConfig(
    { analitycs: "G-TYPO", targets: { prod: { url: "https://x.dev", dataset: "d" } } },
    (dir) => {
      assert.deepEqual(readSiteConfig(dir), {});
      assert.throws(() => resolveTarget(dir, "analitycs"), /Unknown target/);
      assert.equal(resolveInstance(dir).url, "https://x.dev");
    },
  );
});

test("readSiteConfig returns empty when there is no config at all", () => {
  // A static site needs no malloyyo block; this must not throw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-cfg-"));
  try {
    assert.deepEqual(readSiteConfig(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSiteConfig ignores a malformed config instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-cfg-"));
  fs.writeFileSync(path.join(dir, "malloy-config.json"), "{ not json");
  try {
    assert.deepEqual(readSiteConfig(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSiteConfig ignores a non-string analytics value", () => {
  withConfig({ analytics: 42 }, (dir) => assert.deepEqual(readSiteConfig(dir), {}));
});
