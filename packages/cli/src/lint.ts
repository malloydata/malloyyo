// `malloyyo lint` — validate the model's declared dashboards before they're
// published. A dashboard is a `# artifact`-tagged top-level query (the tag is
// the manifest); ./dashboards/<name>/Dashboard.tsx optionally customizes the
// component. Catches: model compile failure, a tagged query that doesn't run,
// a `# suggest {…}` declaration that doesn't compile, a Dashboard.tsx that
// won't compile, an orphaned dashboards/ directory, and leftover manifest.json
// files.

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

/** Backtick-quote a field name unless it's a plain identifier — the same rule
 * the runtime uses when it builds the suggest query. */
const quoteField = (f: string) => (/^[A-Za-z_]\w*$/.test(f) ? f : `\`${f}\``);

export async function lintDashboards(root: string): Promise<LintReport> {
  const abs = resolve(root);
  const dashboards: DashboardLint[] = [];

  const runner = await makeRunner(abs);
  if (!runner.entryExists()) {
    return { ok: false, dashboards: [{ name: "(model)", errors: [`no index.malloy at ${abs}`] }] };
  }
  const arts = await runner.artifacts();
  if (!arts.ok) {
    return { ok: false, dashboards: [{ name: "(model)", errors: [arts.error] }] };
  }
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
    if (errors.length) dashboards.push({ name: dir, errors });
  }

  for (const artifact of artifacts) {
    const errors: string[] = [];

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

    dashboards.push({ name: artifact.name, errors });
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
