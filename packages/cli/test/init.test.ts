// Tests for the .claude/settings.json permission merge in `malloyyo init`.
//
// These exist because of a specific bug: settings.json allowed
// `mcp__malloyyo-local__*` / `mcp__malloy__*` — names from an older scheme —
// while the server `init` writes is `malloyyo_author`. The rules matched
// nothing, so every author tool call stopped for a permission prompt with no
// hint as to why. The list is now derived from developSurface(); these tests
// pin both that derivation and the "merge, never clobber" contract, since the
// file is hand-edited and silently losing someone's rules is the worse bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorToolPermissions, withAuthorPermissions } from "../src/init.js";

test("permissions are derived from the develop surface, under the server key", () => {
  const rules = authorToolPermissions();
  // Every rule addresses the server `init` actually writes into .mcp.json.
  for (const rule of rules) {
    assert.match(rule, /^mcp__malloyyo_author__[a-z_]+$/, `unexpected rule shape: ${rule}`);
  }
  // The five tools `malloyyo mcp --develop` registers (verified over a live
  // stdio handshake). If the engine gains a tool this list grows for free —
  // that is the point — but it must never silently shrink.
  assert.deepEqual(rules, [
    "mcp__malloyyo_author__compile",
    "mcp__malloyyo_author__compile_file",
    "mcp__malloyyo_author__prettify",
    "mcp__malloyyo_author__query",
    "mcp__malloyyo_author__yo_help",
  ]);
});

test("creates permissions.allow when there is no settings file", () => {
  const merged = withAuthorPermissions(undefined);
  assert.ok(!("error" in merged));
  if ("error" in merged) return;
  assert.deepEqual(merged.settings, { permissions: { allow: authorToolPermissions() } });
  assert.equal(merged.added.length, 5);
});

test("merges into an existing file without dropping unrelated keys or rules", () => {
  const before = {
    env: { FOO: "bar" },
    permissions: {
      allow: ["Bash(npm test)", "mcp__vercel__search_vercel_documentation"],
      deny: ["Bash(rm *)"],
    },
  };
  const merged = withAuthorPermissions(structuredClone(before));
  assert.ok(!("error" in merged));
  if ("error" in merged) return;

  const perms = merged.settings.permissions as { allow: string[]; deny: string[] };
  // Pre-existing entries survive, in order, and siblings are untouched.
  assert.deepEqual(perms.allow.slice(0, 2), before.permissions.allow);
  assert.deepEqual(perms.deny, before.permissions.deny);
  assert.deepEqual(merged.settings.env, { FOO: "bar" });
  for (const rule of authorToolPermissions()) assert.ok(perms.allow.includes(rule));
});

test("is idempotent — a second run adds nothing", () => {
  const first = withAuthorPermissions(undefined);
  assert.ok(!("error" in first));
  if ("error" in first) return;

  const second = withAuthorPermissions(first.settings);
  assert.ok(!("error" in second));
  if ("error" in second) return;

  assert.deepEqual(second.added, []);
  assert.deepEqual(second.settings, first.settings);
});

test("adds only the missing rules when some are already allowed", () => {
  const rules = authorToolPermissions();
  const merged = withAuthorPermissions({ permissions: { allow: [rules[0]] } });
  assert.ok(!("error" in merged));
  if ("error" in merged) return;

  assert.deepEqual(merged.added, rules.slice(1));
  assert.deepEqual((merged.settings.permissions as { allow: string[] }).allow, rules);
});

test("refuses to touch a file whose shape it doesn't recognize", () => {
  // Better to leave a permission prompt in place than to overwrite hand-edits.
  for (const bad of [["an", "array"], "a string", 42]) {
    const merged = withAuthorPermissions(bad);
    assert.ok("error" in merged, `should have refused: ${JSON.stringify(bad)}`);
  }
  assert.ok("error" in withAuthorPermissions({ permissions: "nope" }));
  assert.ok("error" in withAuthorPermissions({ permissions: { allow: "nope" } }));
});

// The devcontainer file `init` writes is what makes a model repo openable as a
// Codespace. Two things matter and are easy to break: it must be valid JSONC
// that the Dev Containers tooling will actually parse, and it must never
// overwrite a repo's own container config — `init` is the dev container's own
// postCreateCommand, so on every rebuild it runs against a repo that already
// has one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installDevcontainer } from "../src/init.js";

/** Strip `//` line comments the way a JSONC parser would, for assertions. */
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-init-"));

test("writes a devcontainer that references the published image", () => {
  const root = tmpRepo();
  const res = installDevcontainer(root);
  assert.equal(res.wrote, true);

  const file = path.join(root, ".devcontainer", "devcontainer.json");
  const raw = fs.readFileSync(file, "utf8");
  const parsed = parseJsonc(raw);

  assert.equal(parsed.image, "ghcr.io/malloydata/malloyyo-devcontainer:latest");
  // The comments are the point of shipping JSONC rather than generating JSON —
  // whoever opens this file needs to know what it is and what it may omit.
  assert.match(raw, /^\/\//m);
  fs.rmSync(root, { recursive: true, force: true });
});

test("never overwrites a repo's own devcontainer", () => {
  const root = tmpRepo();
  const file = path.join(root, ".devcontainer", "devcontainer.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "image": "ghcr.io/example/mine:pinned" }\n');

  const res = installDevcontainer(root);
  assert.equal(res.wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), '{ "image": "ghcr.io/example/mine:pinned" }\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test("is idempotent — a second init leaves the first file alone", () => {
  const root = tmpRepo();
  assert.equal(installDevcontainer(root).wrote, true);
  const first = fs.readFileSync(path.join(root, ".devcontainer", "devcontainer.json"), "utf8");
  assert.equal(installDevcontainer(root).wrote, false);
  assert.equal(
    fs.readFileSync(path.join(root, ".devcontainer", "devcontainer.json"), "utf8"),
    first,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
