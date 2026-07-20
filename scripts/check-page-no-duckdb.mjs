#!/usr/bin/env node
// check-page-no-duckdb.mjs
//
// A Next PAGE's SSR render function CANNOT load libduckdb.so — the native lib
// isn't traceable into page bundles, and outputFileTracingIncludes can't target
// a page (verified on Next 16). So any STATIC import path from an app page down
// to the DuckDB-loading packages is a guaranteed prod 500 at render time
// (reference_ssr_page_duckdb_500 / PR #80, PR #103).
//
// This walks the STATIC import graph from every src/app/**/page.tsx and fails if
// it reaches a DuckDB package. Dynamic `import("…")` edges are IGNORED on purpose
// — they defer the native load to call time (which never happens in a page path),
// so they don't 500. Pages may import @/lib/dashboards (the DB-only meta barrel)
// but NOT @/lib/dashboards/engine or @/lib/malloy.
//
// Runs on SOURCE (no build needed). Wired into scripts/preflight.sh.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

// Bare specifiers whose module loads libduckdb.so at EVALUATION time.
const DUCKDB = [/^@malloydata\/db-duckdb/, /^@duckdb\//];

// Resolve an import specifier from `fromFile` to a src file, or null for a bare
// (node) specifier — those are matched against DUCKDB directly, not followed.
function resolveLocal(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const c of [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// STATIC, RUNTIME imports only: `import … from "x"`, `export … from "x"`,
// side-effect `import "x"`. Deliberately EXCLUDES:
//   • dynamic `import("x")` — defers the native load to call time (safe), and
//   • `import type …` / `export type …` — erased at compile time (no eval).
// (An inline `import { type A, b }` keeps `b`'s runtime load, so it's followed —
// conservative, and correct: the module IS evaluated for the value import.)
const RE = /(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^;\n]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
function staticImports(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  let m;
  while ((m = RE.exec(src))) out.push(m[1] || m[2]);
  return out;
}

// First static path from `file` down to a DuckDB package, or null.
function taintPath(file, stack, seen) {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const spec of staticImports(file)) {
    if (DUCKDB.some((r) => r.test(spec))) return [...stack, file, spec];
    const next = resolveLocal(spec, file);
    if (next) {
      const p = taintPath(next, [...stack, file], seen);
      if (p) return p;
    }
  }
  return null;
}

function pages(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) pages(p, acc);
    else if (e === "page.tsx" || e === "page.ts") acc.push(p);
  }
  return acc;
}

const rel = (p) => p.replace(SRC, "src");
const all = pages(join(SRC, "app"));
const offenders = [];
for (const page of all) {
  const p = taintPath(page, [], new Set());
  if (p) offenders.push({ page, path: p });
}

if (offenders.length) {
  console.error("✗ A Next PAGE statically imports the DuckDB path — it WILL 500 in prod.");
  console.error("  A page render function can't load libduckdb.so (reference_ssr_page_duckdb_500).");
  console.error("  Move the Malloy/DuckDB work to an API route. A page may import @/lib/dashboards");
  console.error("  (the DB-only meta barrel) but NOT @/lib/dashboards/engine or @/lib/malloy.\n");
  for (const o of offenders) {
    console.error("  • " + rel(o.page));
    console.error("      " + o.path.map(rel).join("  →  "));
  }
  process.exit(1);
}
console.log(`✓ no page statically imports DuckDB (${all.length} pages checked)`);
