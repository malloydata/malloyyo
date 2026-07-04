import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
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

/** Names of dashboard directories under `dir/dashboards/` that carry a manifest. */
export function listDashboardDirs(dir: string): string[] {
  const base = join(dir, "dashboards");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => {
      const d = join(base, name);
      return statSync(d).isDirectory() && existsSync(join(d, "manifest.json"));
    })
    .sort();
}

/**
 * Gather ./dashboards/<name>/{manifest.json,Dashboard.tsx} into publish payloads.
 * Throws on a malformed manifest or a missing Dashboard.tsx — `lint` runs first in
 * `publish`, so by here these are already validated.
 */
export function gatherDashboards(dir: string): DashboardPayload[] {
  const base = join(dir, "dashboards");
  return listDashboardDirs(dir).map((name) => {
    const raw = readFileSync(join(base, name, "manifest.json"), "utf8");
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      throw new Error(`dashboards/${name}/manifest.json: invalid JSON (${(e as Error).message})`);
    }
    const tsxPath = join(base, name, "Dashboard.tsx");
    if (!existsSync(tsxPath)) throw new Error(`dashboards/${name}: missing Dashboard.tsx`);
    return { name, manifest, source: readFileSync(tsxPath, "utf8") };
  });
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
