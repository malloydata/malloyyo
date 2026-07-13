// `malloyyo lint` — validate the model's declared dashboards before they're
// published. A dashboard is a `# artifact`-tagged top-level query (the tag is
// the manifest); ./dashboards/<name>/Dashboard.tsx optionally customizes the
// component. Catches: model compile failure, a tagged query that doesn't run,
// a `# suggest {…}` declaration that doesn't compile, a Dashboard.tsx that
// won't compile, an orphaned dashboards/ directory, and leftover manifest.json
// files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { listDashboardDirs } from "./gather.js";
import { makeRunner } from "./host.js";

export interface DashboardLint {
  name: string;
  errors: string[];
  /** Non-fatal findings: real problems that don't block publish (e.g. a given
      whose control silently won't render because index.malloy doesn't export it). */
  warnings: string[];
}
export interface LintReport {
  ok: boolean;
  dashboards: DashboardLint[];
}

/** Backtick-quote a field name unless it's a plain identifier — the same rule
 * the runtime uses when it builds the suggest query. */
const quoteField = (f: string) => (/^[A-Za-z_]\w*$/.test(f) ? f : `\`${f}\``);

export async function lintDashboards(root: string): Promise<LintReport> {
  const abs = resolve(root);
  const dashboards: DashboardLint[] = [];

  const runner = await makeRunner(abs);
  if (!runner.entryExists()) {
    return { ok: false, dashboards: [{ name: "(model)", errors: [`no index.malloy at ${abs}`], warnings: [] }] };
  }
  const arts = await runner.artifacts();
  if (!arts.ok) {
    return { ok: false, dashboards: [{ name: "(model)", errors: [arts.error], warnings: [] }] };
  }
  // Peer model files — a dashboard's source is defined in one of these. Compiling
  // a dashboard against its defining file reveals the givens it truly references,
  // even ones index.malloy doesn't re-export (whose controls won't render).
  const peerModels = readdirSync(abs).filter((f) => f.endsWith(".malloy") && f !== "index.malloy");
  const artifacts = arts.artifacts;
  const dirs = listDashboardDirs(abs);
  if (artifacts.length === 0 && dirs.length === 0) return { ok: true, dashboards };

  // Directories must belong to a declared dashboard, and the manifest is gone.
  const declared = new Set(artifacts.map((a) => a.name));
  for (const dir of dirs) {
    const errors: string[] = [];
    if (existsSync(join(abs, "dashboards", dir, "manifest.json"))) {
      errors.push(
        `manifest.json is obsolete — delete it; the model's ` +
          `\`# artifact title="…"\` tag on the query is the manifest now`,
      );
    }
    if (!declared.has(dir)) {
      errors.push(
        `no query is tagged for this dashboard — tag one with ` +
          `\`# artifact\` (or \`# artifact name="${dir}"\`) in the model`,
      );
    }
    if (errors.length) dashboards.push({ name: dir, errors, warnings: [] });
  }

  for (const artifact of artifacts) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // The tagged query must run with its declaration defaults (compile-only),
    // and every given's `# suggest {…}` declaration must itself compile as a
    // restricted query (built exactly as the runtime builds it) — drift in
    // either is caught here, before publish.
    const v = await runner.validate(artifact.query, {});
    if (!v.ok) errors.push(v.error);
    const specs = await runner.givensForQuery(artifact.query);
    if (specs.ok) {
      for (const spec of specs.givens) {
        if (spec.tags?.suggest_query !== undefined) {
          errors.push(
            `given "${spec.name}": suggest_query is obsolete — declare ` +
              `# suggest { source=… dimension=… } or # suggest { query=… }`,
          );
        }
        const suggest = spec.suggest;
        if (!suggest) continue;
        const base = suggest.query
          ? `run: ${suggest.query}`
          : suggest.source && suggest.dimension
            ? `run: ${suggest.source} -> ${quoteField(suggest.dimension)}`
            : null;
        if (base === null) {
          errors.push(
            `given "${spec.name}": suggest must be ` +
              `\`suggest { source=<source> dimension=<field> }\` or ` +
              `\`suggest { query=<named_query> [dimension=<field>] }\``,
          );
          continue;
        }
        const sv = await runner.validateText(base);
        if (!sv.ok) errors.push(`given "${spec.name}": suggest does not compile — ${sv.error}`);
      }
    }

    // A dashboard's filter controls are built from the givens the ENTRY compile
    // surfaces (givensForQuery above). A given the dashboard actually filters on
    // but which index.malloy doesn't re-export never surfaces there, so its
    // control silently won't render — the query still runs with the given baked
    // in at its declaration default. Catch it: the givens the dashboard
    // references from its source's defining file, minus the entry-surfaced set.
    if (specs.ok) {
      const surfaced = new Set(specs.givens.map((s) => s.name));
      const referenced = new Set<string>();
      for (const file of peerModels) {
        const r = await runner.givensForQueryIn(file, artifact.query);
        if (r.ok) for (const s of r.givens) referenced.add(s.name);
      }
      for (const name of referenced) {
        if (surfaced.has(name)) continue;
        warnings.push(
          `filters on given "${name}", which index.malloy doesn't export — its ` +
            `control won't render (the given stays at its default). Re-export it: ` +
            `add "${name}" to the \`import {…}\` and \`export {…}\` in index.malloy.`,
        );
      }
    }

    // Dashboard.tsx is optional (default UI without one); when present it must
    // at least compile (syntax).
    const tsxPath = join(abs, "dashboards", artifact.name, "Dashboard.tsx");
    if (existsSync(tsxPath)) {
      try {
        await esbuild.transform(readFileSync(tsxPath, "utf8"), { loader: "tsx", jsx: "automatic" });
      } catch (e) {
        const msg = (e as { errors?: Array<{ text: string }> }).errors?.map((x) => x.text).join("; ") ?? String(e);
        errors.push(`Dashboard.tsx: ${msg}`);
      }
    }

    dashboards.push({ name: artifact.name, errors, warnings });
  }

  // Warnings never fail lint — only errors do (so publish isn't blocked).
  return { ok: dashboards.every((d) => d.errors.length === 0), dashboards };
}

export function printLintReport(report: LintReport): void {
  for (const d of report.dashboards) {
    const hasErr = d.errors.length > 0;
    const hasWarn = d.warnings.length > 0;
    if (!hasErr && !hasWarn) {
      console.log(`  ✓ ${d.name}`);
      continue;
    }
    console.log(`  ${hasErr ? "✗" : "⚠"} ${d.name}`);
    for (const e of d.errors) console.log(`      ${e}`);
    for (const w of d.warnings) console.log(`      warning: ${w}`);
  }
}
