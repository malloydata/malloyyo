#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { resolveTarget, resolveInstance } from "./config.js";
import { gatherDirectory, gatherDashboards, gitInfo } from "./gather.js";
import { lintDashboards, printLintReport } from "./lint.js";
import { getAccessToken, login } from "./oauth.js";
import { serveMcp } from "./mcp.js";
import { serveDashboard } from "./dashboard.js";
import { bundleDashboards } from "./bundle.js";
import { initCmd } from "./init.js";
import { sqlCmd } from "./sql.js";
import { launchCmd } from "./launch.js";
import { clearCreds } from "./store.js";
import type { PublishRequest, ModelStatus } from "./protocol.js";
// Single source of truth: the build runs after the release bump, so esbuild
// inlines the current package.json version (tree-shaken to just the string).
// Feeds both `malloyyo --version` and the MCP server's serverInfo.version.
import { version as VERSION } from "../package.json";

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "";
}

async function publish(
  target: string,
  dir: string,
  opts: { token?: string; dryRun?: boolean; skipLint?: boolean },
): Promise<void> {
  const root = resolve(dir);
  const t = resolveTarget(root, target);
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });

  const { files, config } = gatherDirectory(root);
  if (files.length === 0) {
    throw new Error(`No .malloy files found under ${root}`);
  }

  // Lint dashboards before sending — a broken dashboard shouldn't reach the server.
  if (!opts.skipLint) {
    const report = await lintDashboards(root);
    if (report.dashboards.length > 0) {
      console.log("dashboards:");
      printLintReport(report);
    }
    if (!report.ok) {
      throw new Error("dashboard lint failed — fix the above, or pass --skip-lint");
    }
  }

  const git = gitInfo(root);
  const dashboards = await gatherDashboards(root);
  const body: PublishRequest = { files, config, git, dashboards };

  const provenance = git.sha
    ? `${git.branch}@${shortSha(git.sha)}${git.dirty ? " (dirty)" : ""}`
    : "(no git)";
  console.log(`→ ${t.url}  dataset=${t.dataset}`);
  console.log(`  ${files.length} file(s)  ${provenance}`);

  if (opts.dryRun) {
    console.log("dry run — not sending");
    return;
  }

  const res = await fetch(`${t.url}/api/datasets/${t.dataset}/model/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as ModelStatus;

  if (!res.ok || !out.ok) {
    throw new Error(`publish failed: ${out.error ?? `${res.status} ${res.statusText}`}`);
  }
  console.log(
    `✓ published version ${out.version} — ${out.sources?.length ?? 0} source(s)` +
      (dashboards.length ? `, ${dashboards.length} dashboard(s)` : ""),
  );
}

async function status(target: string, opts: { token?: string }): Promise<void> {
  const t = resolveTarget(resolve("."), target);
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });
  const res = await fetch(`${t.url}/api/datasets/${t.dataset}/model/status`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(`status failed: ${res.status} ${res.statusText}`);
  }
  const s = (await res.json()) as ModelStatus;
  const git = s.git;
  console.log(`${t.name}: ${t.url}  dataset=${t.dataset}`);
  console.log(`  version ${s.version ?? "?"}` + (git?.sha ? `  ${git.branch}@${shortSha(git.sha)}` : ""));
  console.log(`  ${s.compileError ? `✗ ${s.compileError}` : `✓ compiled ${s.compiledAt ?? ""}`}`);
}

async function loginCmd(target: string | undefined): Promise<void> {
  const inst = resolveInstance(resolve("."), target);
  await login(inst.url);
  console.log(`✓ logged in to ${inst.name} (${inst.url})`);
}

async function logoutCmd(target: string | undefined): Promise<void> {
  const inst = resolveInstance(resolve("."), target);
  console.log(clearCreds(inst.url) ? `✓ logged out of ${inst.url}` : `not logged in to ${inst.url}`);
}

const program = new Command();
program
  .name("malloyyo")
  .description("Publish Malloy models to a Malloyyo instance")
  .version(VERSION);

program
  .command("login")
  .argument("[target]", "target name or instance URL (optional if the config has one target)")
  .description("sign in to an instance in your browser (stores a token)")
  .action(loginCmd);

program
  .command("logout")
  .argument("[target]", "target name or instance URL (optional if the config has one target)")
  .description("forget the stored token for an instance")
  .action(logoutCmd);

program
  .command("publish")
  .argument("<target>", "named target from the `malloyyo` config block")
  .argument("[dir]", "directory to publish", ".")
  .option("--token <token>", "bearer token (overrides login/env)")
  .option("--dry-run", "gather and report what would be sent, but don't POST")
  .option("--skip-lint", "skip the pre-publish dashboard lint")
  .description('push the Malloy model in <dir> (default ".") to <target>')
  .action(publish);

program
  .command("lint")
  .argument("[dir]", "directory to lint", ".")
  .description("validate ./dashboards against the model (manifest, query, givens, Dashboard.tsx)")
  .action(async (dir: string) => {
    const report = await lintDashboards(resolve(dir));
    if (report.dashboards.length === 0) {
      console.log("no dashboards to lint");
      return;
    }
    printLintReport(report);
    if (!report.ok) process.exit(1);
  });

program
  .command("status")
  .argument("<target>", "named target from the `malloyyo` config block")
  .option("--token <token>", "bearer token (overrides login/env)")
  .description("show what's live on <target>: version, commit, compile state")
  .action(status);

program
  .command("mcp")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .option("--develop", "author surface: compile/prettify/query any .malloy in the project")
  .option("--explore", "explore surface: the claude.ai web preview (index.malloy only) [default]")
  .description(
    "run a local stdio MCP server over the Malloy model in the current directory. " +
      "--develop for authoring, --explore (default) to preview the web experience",
  )
  .action(async (opts: { root?: string; develop?: boolean; explore?: boolean }) => {
    if (opts.develop && opts.explore) {
      throw new Error("pass only one of --develop / --explore");
    }
    await serveMcp({
      root: opts.root,
      version: VERSION,
      mode: opts.develop ? "develop" : "explore",
    });
  });

program
  .command("init")
  .argument("[dir]", "model repo to set up", ".")
  .description(
    "set up a model repo: write .mcp.json so `cd <repo> && claude` opens in " +
      "author mode, and scaffold index.malloy if missing",
  )
  .action(initCmd);

program
  .command("sql")
  .argument("[connection]", "connection name from malloy-config.json", "duckdb")
  .option("-e, --execute <sql>", "SQL to run (else read from -f <file> or stdin)")
  .option("-f, --file <path>", "read SQL from a file")
  .option("-C, --root <dir>", "project root for malloy-config.json discovery (default: current directory)")
  .option("-j, --json", "print result rows as JSON")
  .description(
    "run raw SQL against a configured connection using the embedded DuckDB — " +
      "e.g. COPY a web CSV into docs/*.parquet, no standalone duckdb needed",
  )
  .action(
    async (
      connection: string | undefined,
      opts: { execute?: string; file?: string; json?: boolean; root?: string },
    ) => {
      await sqlCmd(connection, opts);
    },
  );

program
  .command("author")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .description("launch Claude wired ONLY to the author surface (compile/edit the model)")
  .action(async (opts: { root?: string }) => {
    await launchCmd("author", opts);
  });

program
  .command("test")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .description("launch Claude wired ONLY to the explore surface — the claude.ai web preview")
  .action(async (opts: { root?: string }) => {
    await launchCmd("test", opts);
  });

program
  .command("dashboard")
  .argument("<action>", "action to run (dev | bundle)")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .option("-p, --port <port>", "port to serve on (dev)", "4173")
  .option("-o, --out <dir>", "output directory (bundle)", "docs")
  .option("--title <title>", "site title (bundle; default: project directory name)")
  .option("--target <target>", "deploy target: pages | vercel (bundle)", "pages")
  .option("--duckdb <source>", "DuckDB binaries: cdn | bundled (bundle)", "cdn")
  .option("--no-serve", "bundle only; don't serve the result (bundle)")
  .description("preview dashboards locally (dev), or build a static site from them (bundle)")
  .action(
    async (
      action: string,
      opts: { root?: string; port?: string; out?: string; title?: string; serve?: boolean; target?: string; duckdb?: string },
    ) => {
      if (action === "dev") {
        await serveDashboard({ root: opts.root, port: Number(opts.port) });
        return;
      }
      if (action === "bundle") {
        if (opts.target !== "pages" && opts.target !== "vercel") {
          throw new Error(`unknown --target '${opts.target}' (expected: pages | vercel)`);
        }
        if (opts.duckdb !== "cdn" && opts.duckdb !== "bundled") {
          throw new Error(`unknown --duckdb '${opts.duckdb}' (expected: cdn | bundled)`);
        }
        await bundleDashboards({
          root: opts.root,
          out: opts.out,
          title: opts.title,
          serve: opts.serve,
          target: opts.target,
          duckdb: opts.duckdb,
          // `dashboard dev` owns 4173/4174; default the bundle preview clear of
          // both so you can run the two side by side.
          port: opts.port === "4173" ? 4180 : Number(opts.port),
        });
        return;
      }
      throw new Error(`unknown dashboard action '${action}' (expected: dev | bundle)`);
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
