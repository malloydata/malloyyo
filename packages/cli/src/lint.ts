// `malloyyo lint` — validate a model's dashboards before publish. Structure v2:
// each dashboard is a self-contained `dashboards/<name>.malloy` whose
// `## artifact` names its tiles, with an optional flat `dashboards/<name>.jsx`
// (or .tsx) component. Every check is LOCAL to one file — the file compiles as
// its own entry (catching undefined tiles / missing imports / unresolved givens
// loudly, at the line), each tile compiles, `dashboard_columns` is a positive
// int, each referenced given's `# suggest {…}` compiles, the component compiles,
// no duplicate names, no orphaned component. `dashboards/index.jsx` is the
// static bundle's landing page, not an orphan — it is parsed, not published.
// `index.malloy` is validated separately as the MCP/ltool surface.

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

/** The run-expressions a component hard-codes as `query="…"` string literals
    (`<Panel query="…"/>`, `<VegaChart query="…"/>`). Only string literals — a
    `query={expr}` is dynamic and skipped. Deduped. Lint checks each still
    resolves, so a component pointing at a renamed/removed query fails loudly. */
function componentQueryLiterals(source: string): string[] {
  const out = new Set<string>();
  const re = /\bquery\s*=\s*(["'])([^"'\n]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[2]!.trim());
  return [...out];
}

/** Syntax-check the static bundle's landing page (`dashboards/index.jsx|tsx`).
 *
 * Only a parse: it is ordinary React that never sees Malloy, so there is no
 * scope to resolve `query="…"` against — unlike a dashboard component, whose
 * literals are checked against its dashboard. esbuild.transform is the same
 * check the bundler's own pass would fail on, just moved earlier. */
function landingPageErrors(dir: string, file: string): string[] {
  const ext = file.endsWith(".tsx") ? "tsx" : "jsx";
  try {
    esbuild.transformSync(readFileSync(join(dir, file), "utf8"), { loader: ext, jsx: "automatic" });
    return [];
  } catch (e) {
    const msg = (e as { errors?: Array<{ text: string }> }).errors?.map((x) => x.text).join("; ") ?? String(e);
    return [`${file}: ${msg}`];
  }
}

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
  //
  // `index.jsx|tsx` is the ONE exception, and it is not an orphan: the bundler
  // reads it as the static site's written landing page (bundle.ts, "A repo may
  // ship `dashboards/index.jsx|tsx` as a written landing page"). It is plain
  // React with no Malloy and no query by design — that is the whole point of it
  // — so demanding an `index.malloy` beside it asks for a dashboard nobody wants.
  // Treating it as an orphan made `lint` fail, and publish gates on lint, so a
  // repo that bundled perfectly could not be published at all.
  //
  // An `index.malloy` that DOES exist is a dashboard named "index", and its
  // component is this same file; the check below already passes in that case,
  // and the loop over malloyFiles lints the pair normally.
  for (const c of entries.filter((f) => /\.(jsx|tsx)$/.test(f)).sort()) {
    const cbase = c.replace(/\.(jsx|tsx)$/, "");
    if (malloyBases.has(cbase)) continue;
    if (cbase === "index") {
      // Not published — the hosted app has its own home page, and gatherDashboards
      // only ever walks .malloy files — but it still has to compile, or `bundle`
      // fails later with the same error this could have given now.
      dashboards.push({ name: c, errors: landingPageErrors(dir, c), warnings: [] });
      continue;
    }
    dashboards.push({
      name: c,
      errors: [`component "${c}" has no matching "${cbase}.malloy" dashboard`],
      warnings: [],
    });
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
    if (art.warnings) warnings.push(...art.warnings); // non-fatal authoring issues (e.g. dashboard_columns on a single-tile artifact)

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

    // Composite → its tiles; single-query artifact → its one run-expression.
    // Both get compiled/introspected the same way below.
    const tiles = art.tiles ?? (art.query ? [art.query] : []);
    if (tiles.length === 0) errors.push(`\`# artifact\` declares neither a query nor tiles`);
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

    // The optional component (flat sibling) must at least compile (syntax), and
    // each `query="…"` it hard-codes must still resolve in the dashboard's scope.
    for (const ext of ["jsx", "tsx"] as const) {
      const cp = join(dir, `${base}.${ext}`);
      if (!existsSync(cp)) continue;
      const source = readFileSync(cp, "utf8");
      try {
        await esbuild.transform(source, { loader: ext, jsx: "automatic" });
      } catch (e) {
        const msg = (e as { errors?: Array<{ text: string }> }).errors?.map((x) => x.text).join("; ") ?? String(e);
        errors.push(`${base}.${ext}: ${msg}`);
        continue;
      }
      for (const q of componentQueryLiterals(source)) {
        const v = await runner.validateIn(entryFile, q, {});
        if (!v.ok) errors.push(`${base}.${ext}: query "${q}" doesn't resolve — ${v.error}`);
      }
    }

    dashboards.push({ name: art.name, errors, warnings });
  }

  // Link check: every `# drill { to=<slug> }` on a source dimension must point at
  // a real dashboard (drill `to=` is opaque tag text Malloy never validates, so a
  // typo or a renamed dashboard is silent dead navigation without this).
  const drills = await runner.drillTargets();
  if (drills.ok) {
    for (const target of drills.targets) {
      if (!seenNames.has(target)) {
        dashboards.push({
          name: `drill → ${target}`,
          errors: [
            `# drill { to=[${target}] } targets no dashboard — ` +
              `add dashboards/${target}.malloy, or fix the slug to a real dashboard`,
          ],
          warnings: [],
        });
      }
    }
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

// ── The repo ────────────────────────────────────────────────────────────────
//
// A repo is the unit you validate, because it is the unit that publishes. One
// dataset or several, `malloyyo lint` answers for all of it — and it answers the
// LAYOUT question too, using the same rules the server uses (they live in the
// engine, over an injected lister). A repo that lints clean here is one the
// server will accept; that equivalence is the whole point of sharing the rules
// rather than writing a second copy that agrees today.
//
// This matters more than it looks, because a GitHub-backed repo refreshes on a
// TRIGGER. Nobody is watching a push the way they watch a publish, so the last
// moment a human sees an error is here.

import { layoutFromListing, type DirEntry, type DirLister } from "@malloyyo/mcp-engine";

/** Read a directory of the repo on disk, "" being its root. Missing is empty —
    the same answer the server's lister gives for a path GitHub does not have. */
function fsLister(root: string): DirLister {
  return async (path: string): Promise<DirEntry[]> => {
    const dir = path ? join(root, path) : root;
    if (!existsSync(dir)) return [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        type: e.isDirectory() ? ("dir" as const) : ("file" as const),
      }));
  };
}

/**
 * What `lint` and `publish` say when they meet a repo built the old way.
 *
 * TRANSITIONAL. This constant, the two places that print it, and
 * `yo_help("repo/convert-single-dataset")` are the whole of the single-dataset
 * deprecation — delete those three and nothing else knows about it.
 */
export const OLD_LAYOUT_NOTICE = [
  "This repo has index.malloy at its root — the old single-dataset layout.",
  "Repos now publish one dataset per directory under datasets/.",
  "",
  "It still works. To convert it, run `claude` here and ask it to convert this",
  'repo to the datasets/ layout, or read yo_help("repo/convert-single-dataset").',
].join("\n");

export interface RepoLintReport {
  ok: boolean;
  /** The repo is the old single-dataset shape. Transitional — see
      OLD_LAYOUT_NOTICE. */
  oldLayout?: boolean;
  /** The repo's shape is wrong — nothing could be linted. */
  layoutError?: string;
  /** One entry per dataset the repo publishes. `dir` is "" for a single-dataset
      repo, whose one dataset is the repo root. */
  datasets: { name: string; dir: string; report: LintReport }[];
}

/**
 * Lint every dataset the repo publishes.
 *
 * Layout problems are lint errors, not surprises for later: a repo with both a
 * root `index.malloy` and a `datasets/` directory, or a `datasets/` subdirectory
 * with no entry file, fails HERE — on a laptop, with the directory named — rather
 * than on a server whose logs the author cannot read.
 */
export async function lintRepo(root: string): Promise<RepoLintReport> {
  const abs = resolve(root);
  const layout = await layoutFromListing(fsLister(abs), abs);
  if (!layout.ok) return { ok: false, layoutError: layout.error, datasets: [] };

  const oldLayout = layout.kind === "single";
  const targets = oldLayout
    ? [{ name: "", dir: "" }]
    : layout.datasets.map((d) => ({ name: d.name, dir: d.dir }));

  const datasets: RepoLintReport["datasets"] = [];
  for (const t of targets) {
    const report = await lintDashboards(t.dir ? join(abs, t.dir) : abs);
    datasets.push({ name: t.name, dir: t.dir, report });
  }
  return { ok: datasets.every((d) => d.report.ok), datasets, oldLayout };
}

/** Print a repo lint, naming each dataset when there is more than one. */
export function printRepoLintReport(repo: RepoLintReport): void {
  if (repo.layoutError) {
    console.log(`  ✗ ${repo.layoutError}`);
    return;
  }
  const many = repo.datasets.length > 1;
  for (const d of repo.datasets) {
    if (many) console.log(`  ${d.dir}`);
    if (d.report.dashboards.length === 0 && many) console.log("    (no dashboards)");
    printLintReport(d.report);
  }
}
