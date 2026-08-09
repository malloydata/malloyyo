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
