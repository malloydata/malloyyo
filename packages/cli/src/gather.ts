import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { makeRunner } from "./host.js";
import type { ModelFile, GitInfo, DashboardPayload } from "./protocol.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Collect every *.malloy file under `dir` (recursively, skipping hidden dirs and
 * node_modules) plus malloy-config.json at the root. Paths are relative to `dir`,
 * POSIX-separated, so imports resolve the same way on the server.
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
