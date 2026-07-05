// `malloyyo lint` — validate dashboards in ./dashboards against the model before
// they're published. Catches the failure modes we hit by hand: malformed
// manifest, a query the model doesn't expose, given names/types that don't match
// the model's givens (drift), and Dashboard.tsx that won't compile.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { listDashboardDirs } from "./gather.js";
import { makeRunner } from "./host.js";

export interface DashboardLint {
  name: string;
  errors: string[];
}
export interface LintReport {
  ok: boolean;
  dashboards: DashboardLint[];
}

interface GivenSpec {
  name?: unknown;
  type?: unknown;
  default?: unknown;
}

export async function lintDashboards(root: string): Promise<LintReport> {
  const abs = resolve(root);
  const names = listDashboardDirs(abs);
  const dashboards: DashboardLint[] = [];
  if (names.length === 0) return { ok: true, dashboards };

  const runner = await makeRunner(abs);
  if (!runner.entryExists()) {
    return { ok: false, dashboards: [{ name: "(model)", errors: [`no index.malloy at ${abs}`] }] };
  }

  for (const name of names) {
    const errors: string[] = [];
    const dir = join(abs, "dashboards", name);

    // manifest.json — shape + collect the given defaults to bind.
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    } catch (e) {
      errors.push(`manifest.json: invalid JSON (${(e as Error).message})`);
    }
    let query: string | undefined;
    const givenValues: Record<string, unknown> = {};
    if (manifest) {
      if (typeof manifest.title !== "string") errors.push(`manifest: "title" must be a string`);
      if (typeof manifest.query !== "string") errors.push(`manifest: "query" must be a string`);
      else query = manifest.query;
      const givens = manifest.givens;
      if (!Array.isArray(givens)) {
        errors.push(`manifest: "givens" must be an array`);
      } else {
        for (const g of givens as GivenSpec[]) {
          if (typeof g?.name !== "string") {
            errors.push(`manifest: every given needs a string "name"`);
            continue;
          }
          if (g.type !== "string" && g.type !== "number" && g.type !== "boolean") {
            errors.push(`given "${g.name}": "type" must be "string", "number", or "boolean"`);
          }
          if (g.default !== undefined) givenValues[g.name] = g.default;
        }
      }
    }

    // Dashboard.tsx — exists and compiles (syntax).
    const tsxPath = join(dir, "Dashboard.tsx");
    if (!existsSync(tsxPath)) {
      errors.push(`missing Dashboard.tsx`);
    } else {
      try {
        await esbuild.transform(readFileSync(tsxPath, "utf8"), { loader: "tsx", jsx: "automatic" });
      } catch (e) {
        const msg = (e as { errors?: Array<{ text: string }> }).errors?.map((x) => x.text).join("; ") ?? String(e);
        errors.push(`Dashboard.tsx: ${msg}`);
      }
    }

    // The query + givens must resolve against the model (compile-only).
    if (query) {
      const v = await runner.validate(query, givenValues);
      if (!v.ok) errors.push(v.error);
    }

    dashboards.push({ name, errors });
  }

  return { ok: dashboards.every((d) => d.errors.length === 0), dashboards };
}

export function printLintReport(report: LintReport): void {
  for (const d of report.dashboards) {
    if (d.errors.length === 0) {
      console.log(`  ✓ ${d.name}`);
    } else {
      console.log(`  ✗ ${d.name}`);
      for (const e of d.errors) console.log(`      ${e}`);
    }
  }
}
