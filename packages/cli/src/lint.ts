// `malloyyo lint` — validate a model's dashboards before publish. Structure v2:
// each dashboard is a self-contained `dashboards/<name>.malloy` whose
// `## artifact` names its tiles, with an optional flat `dashboards/<name>.jsx`
// (or .tsx) component. Every check is LOCAL to one file — the file compiles as
// its own entry (catching undefined tiles / missing imports / unresolved givens
// loudly, at the line), each tile compiles, `dashboard_columns` is a positive
// int, each referenced given's `# suggest {…}` compiles, the component compiles,
// no duplicate names, no orphaned component. `index.malloy` is validated
// separately as the MCP/ltool surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { makeRunner, type ModelRunner } from "./host.js";

export interface DashboardLint {
  name: string;
  errors: string[];
  /** Non-fatal findings: real problems that don't block publish. */
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
  const runner = await makeRunner(abs);
  try {
    return await runLint(abs, runner);
  } finally {
    // Close the shared connections so the CLI process exits promptly.
    await runner.dispose();
  }
}

async function runLint(abs: string, runner: ModelRunner): Promise<LintReport> {
  const dashboards: DashboardLint[] = [];

  // index.malloy is the MCP/ltool surface — validate it compiles on its own,
  // independent of whether any dashboard imports it.
  if (runner.entryExists()) {
    const arts = await runner.artifacts();
    if (!arts.ok) dashboards.push({ name: "index.malloy", errors: [arts.error], warnings: [] });
  }

  const dir = join(abs, "dashboards");
  if (!existsSync(dir)) return { ok: dashboards.every((d) => d.errors.length === 0), dashboards };

  const entries = readdirSync(dir);
  const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();
  const malloyBases = new Set(malloyFiles.map((f) => f.slice(0, -".malloy".length)));

  // Orphaned component: a `dashboards/<name>.jsx|tsx` with no `<name>.malloy`.
  for (const c of entries.filter((f) => /\.(jsx|tsx)$/.test(f)).sort()) {
    const cbase = c.replace(/\.(jsx|tsx)$/, "");
    if (!malloyBases.has(cbase)) {
      dashboards.push({
        name: c,
        errors: [`component "${c}" has no matching "${cbase}.malloy" dashboard`],
        warnings: [],
      });
    }
  }

  const seenNames = new Map<string, string>(); // resolved name → declaring file
  for (const file of malloyFiles) {
    const base = file.slice(0, -".malloy".length);
    const entryFile = join("dashboards", file); // relative — the runner joins it to root
    const errors: string[] = [];
    const warnings: string[] = [];

    // Compile the dashboard file AS its own entry. A bad import / undefined tile
    // source / unresolved given surfaces here, loudly, at its line.
    const res = await runner.artifactForFile(entryFile, base);
    if (!res.ok) {
      dashboards.push({ name: base, errors: [res.error], warnings: [] });
      continue;
    }
    // A `.malloy` with no `## artifact` is a shared include, not a dashboard.
    if (!res.artifact) continue;
    const art = res.artifact;

    if (seenNames.has(art.name)) {
      errors.push(`duplicate dashboard name "${art.name}" (also declared by ${seenNames.get(art.name)})`);
    } else {
      seenNames.set(art.name, file);
    }

    if (
      art.dashboard_columns !== undefined &&
      (!Number.isInteger(art.dashboard_columns) || art.dashboard_columns < 1)
    ) {
      errors.push(`dashboard_columns must be a positive integer (got ${JSON.stringify(art.dashboard_columns)})`);
    }

    const tiles = art.tiles ?? [];
    if (tiles.length === 0) errors.push(`\`## artifact\` declares no tiles`);
    // Each tile must compile against THIS dashboard file's scope.
    for (const tile of tiles) {
      const v = await runner.validateIn(entryFile, tile, {});
      if (!v.ok) errors.push(`tile "${tile}": ${v.error}`);
    }

    // Every referenced given's `# suggest {…}` must compile exactly as the
    // runtime builds it (drift in the suggest query is caught before publish).
    const specs = await runner.dashboardGivens(entryFile, tiles);
    if (specs.ok) {
      for (const spec of specs.givens) {
        const suggest = spec.suggest;
        if (!suggest) continue;
        const suggestBase = suggest.query
          ? `run: ${suggest.query}`
          : suggest.source && suggest.dimension
            ? `run: ${suggest.source} -> ${quoteField(suggest.dimension)}`
            : null;
        if (suggestBase === null) {
          errors.push(
            `given "${spec.name}": suggest must be ` +
              `\`suggest { source=<source> dimension=<field> }\` or ` +
              `\`suggest { query=<query> [dimension=<field>] }\``,
          );
          continue;
        }
        const sv = await runner.validateTextIn(entryFile, suggestBase);
        if (!sv.ok) errors.push(`given "${spec.name}": suggest does not compile — ${sv.error}`);
      }
    }

    // The optional component (flat sibling) must at least compile (syntax).
    for (const ext of ["jsx", "tsx"] as const) {
      const cp = join(dir, `${base}.${ext}`);
      if (!existsSync(cp)) continue;
      try {
        await esbuild.transform(readFileSync(cp, "utf8"), { loader: ext, jsx: "automatic" });
      } catch (e) {
        const msg = (e as { errors?: Array<{ text: string }> }).errors?.map((x) => x.text).join("; ") ?? String(e);
        errors.push(`${base}.${ext}: ${msg}`);
      }
    }

    dashboards.push({ name: art.name, errors, warnings });
  }

  // TODO(v2): validate `# drill { to=<slug> }` targets on source dimensions
  // resolve to a discovered dashboard file (needs walking the model's dims).

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
