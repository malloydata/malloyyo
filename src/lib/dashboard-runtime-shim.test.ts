// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// DRIFT TEST for the `@malloyyo/dashboard` import surface.
//
// A hosted custom dashboard's `import { X } from "@malloyyo/dashboard"` is
// resolved by RUNTIME_SHIM (src/lib/dashboards/bundle.ts), which re-exports
// names off window.__DASH_RUNTIME__ — the namespace of
// packages/cli/src/frame-runtime/index.ts, put there by the vendor build.
//
// The two lists are maintained by hand and CAN drift, and the failure is nasty:
// the export exists at runtime, the CLI preview bundles it fine (it aliases to
// the real source), and `lint` passes (it transpiles without resolving
// imports) — but the hosted bundle route 500s with "No matching export in
// vruntime:runtime for import X" the first time someone opens the dashboard.
// That shipped: MultiSelect and TimeRange were live in the runtime and missing
// from the shim, breaking published dashboards that used them.
//
// Run: npm test   (tsx --test src/lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const RUNTIME_INDEX = join(ROOT, "packages", "cli", "src", "frame-runtime", "index.ts");
const BUNDLE_TS = join(ROOT, "src", "lib", "dashboards", "bundle.ts");

/** Names `frame-runtime/index.ts` exports: `export { a, b } from …` + `export function f`. */
function runtimeExports(): Set<string> {
  const src = readFileSync(RUNTIME_INDEX, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  return names;
}

/** Names RUNTIME_SHIM re-exports, i.e. every `x = D.x`. */
function shimExports(): Set<string> {
  const src = readFileSync(BUNDLE_TS, "utf8");
  const shim = src.match(/const RUNTIME_SHIM = `([\s\S]*?)`;/);
  assert.ok(shim, "RUNTIME_SHIM not found in bundle.ts — did it move or get renamed?");
  return new Set([...shim[1].matchAll(/(\w+)\s*=\s*D\.(\w+)/g)].map((m) => m[1]));
}

test("RUNTIME_SHIM re-exports every frame-runtime export", () => {
  const real = runtimeExports();
  const shimmed = shimExports();

  assert.ok(real.size > 10, `parsed only ${real.size} exports from frame-runtime — parser is broken`);

  const missing = [...real].filter((n) => !shimmed.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `Missing from RUNTIME_SHIM in src/lib/dashboards/bundle.ts: ${missing.join(", ")}.\n` +
      "A hosted dashboard importing one of these fails to bundle at view time " +
      "(500 on /api/dashboards/*/bundle), while the CLI preview and lint both pass. " +
      "Add each as `name = D.name`.",
  );
});

test("RUNTIME_SHIM re-exports nothing the runtime doesn't have", () => {
  const real = runtimeExports();
  const extra = [...shimExports()].filter((n) => !real.has(n)).sort();
  assert.deepEqual(
    extra,
    [],
    `RUNTIME_SHIM re-exports names frame-runtime no longer has: ${extra.join(", ")}. ` +
      "These resolve to undefined at runtime — remove them, or restore the export.",
  );
});

// Aliasing (`x = D.y`) would silently rename the public surface; both lists are
// meant to be the same names.
test("RUNTIME_SHIM does not alias", () => {
  const src = readFileSync(BUNDLE_TS, "utf8");
  const shim = src.match(/const RUNTIME_SHIM = `([\s\S]*?)`;/)![1];
  const aliased = [...shim.matchAll(/(\w+)\s*=\s*D\.(\w+)/g)]
    .filter((m) => m[1] !== m[2])
    .map((m) => `${m[1]} = D.${m[2]}`);
  assert.deepEqual(aliased, [], `RUNTIME_SHIM aliases exports: ${aliased.join(", ")}`);
});
