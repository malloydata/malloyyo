import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { makeRunner } from "./host.js";
import { aboutPage } from "./discover.js";
import type { ModelFile, GitInfo, DashboardPayload } from "./protocol.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** What `malloyyo init` writes, and the only dev container GitHub finds without
    being told where to look (a `devcontainer_path=` URL parameter can name
    another, but only one that is already committed). Published as a model file
    so "does this repo open as a codespace?" is answerable from the model alone. */
export const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";

/**
 * Collect every *.malloy file under `dir` (recursively, skipping hidden dirs and
 * node_modules) plus malloy-config.json at the root. Paths are relative to `dir`,
 * POSIX-separated, so imports resolve the same way on the server.
 *
 * `.devcontainer/devcontainer.json` rides along too, despite the hidden-dir skip
 * and despite Malloy never reading it: its PRESENCE in the published file list is
 * how the server knows this repo can be opened as a codespace. Nothing else in
 * the stored model says so, and asking GitHub per page-view would spend the
 * unauthenticated rate limit on a question the publish already answered.
 */
export function gatherDirectory(dir: string): { files: ModelFile[]; config?: string } {
  const files: ModelFile[] = [];

  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur)) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".malloy")) {
        files.push({
          path: relative(dir, full).split(sep).join("/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(dir);

  // Explicit, because walk() skips every dotted entry — see DEVCONTAINER_PATH.
  const devcontainer = join(dir, ...DEVCONTAINER_PATH.split("/"));
  if (existsSync(devcontainer)) {
    files.push({ path: DEVCONTAINER_PATH, content: readFileSync(devcontainer, "utf8") });
  }

  const configPath = join(dir, "malloy-config.json");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;

  return { files, config };
}

/** Names of dashboard directories under `dir/dashboards/`. */
export function listDashboardDirs(dir: string): string[] {
  const base = join(dir, "dashboards");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => statSync(join(base, name)).isDirectory())
    .sort();
}

/**
 * Structure v2: gather the model's dashboards into publish payloads. Each
 * `dashboards/<name>.malloy` is a dashboard, compiled AS its own entry to read
 * its `## artifact` / inline `# artifact` (no manifest file — the tag is the
 * manifest). The synthesized manifest carries `entryFile` + `tiles` +
 * `dashboard_columns` so the SERVER runs the dashboard against its own file
 * (the same way the CLI dev preview does). `source` is the optional flat
 * component `dashboards/<name>.jsx|tsx` ("" = the runtime's default dashboard).
 * The dashboard `.malloy` files themselves ride along as ordinary model files
 * (gatherDirectory collects them), so the server can compile each as an entry.
 * `lint` runs first in `publish`, so by here these are already validated.
 */
export async function gatherDashboards(dir: string): Promise<DashboardPayload[]> {
  const dashDir = join(dir, "dashboards");
  if (!existsSync(dashDir)) return [];
  const runner = await makeRunner(dir);
  try {
    const files = readdirSync(dashDir)
      .filter((f) => f.endsWith(".malloy"))
      .sort();
    const payloads: DashboardPayload[] = [];
    for (const file of files) {
      const base = file.slice(0, -".malloy".length);
      const entryFile = `dashboards/${file}`; // POSIX, relative to root — matches the stored files
      const res = await runner.artifactForFile(entryFile, base);
      if (!res.ok) throw new Error(`dashboard ${file}: ${res.error}`);
      if (!res.artifact) continue; // a shared include with no `## artifact`
      const a = res.artifact;
      const manifest: Record<string, unknown> = { title: a.title, entryFile };
      if (a.tiles) manifest.tiles = a.tiles;
      // Single-query artifact (no tiles): the run-expression IS the dashboard.
      // Persist it — the hosted app needs manifest.query to run/introspect it.
      else if (a.query) manifest.query = a.query;
      if (a.dashboard_columns !== undefined) manifest.dashboard_columns = a.dashboard_columns;
      if (a.description) manifest.description = a.description;
      if (a.givens) manifest.givens = a.givens;
      if (a.autorun === false) manifest.autorun = false;
      const component = ["jsx", "tsx"]
        .map((ext) => join(dashDir, `${base}.${ext}`))
        .find((p) => existsSync(p));
      payloads.push({
        name: a.name || base,
        manifest,
        source: component ? readFileSync(component, "utf8") : "",
      });
    }
    // The written front door, first — same order the dev server and the bundle
    // use. It has no `.malloy`, so it carries no entryFile, query or tiles: the
    // manifest is a title, and the component is the whole dashboard. Until now
    // it was never uploaded at all, which is why a published dataset had no
    // introduction even when the repo shipped one.
    //
    // Added after the loop, and only if no artifact already resolved to its
    // name — an artifact's name comes from its `## artifact { name= }` tag, not
    // its filename, so checking for `dashboards/index.malloy` alone would miss a
    // tag that names some other file "index" and would publish two artifacts
    // sharing one name.
    const about = aboutPage(dir);
    if (about?.tsxPath && !payloads.some((p) => p.name === about.name)) {
      payloads.unshift({
        name: about.name,
        manifest: { title: about.title },
        source: readFileSync(about.tsxPath, "utf8"),
      });
    }
    return payloads;
  } finally {
    await runner.dispose();
  }
}

/** Best-effort git provenance for `dir`. Returns {} outside a git checkout. */
export function gitInfo(dir: string): GitInfo {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // suppress git's own stderr (e.g. "no remote 'origin'")
    }).trim();
  try {
    let repo: string | undefined;
    try {
      // origin git@host:owner/name.git | https://host/owner/name(.git) -> owner/name
      repo = git(["remote", "get-url", "origin"]).replace(
        /^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
        "$1",
      );
    } catch {
      // no origin remote — leave repo undefined
    }
    return {
      repo,
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      sha: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
    };
  } catch {
    return {};
  }
}
