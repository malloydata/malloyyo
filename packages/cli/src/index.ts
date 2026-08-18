#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { resolveTarget, resolveInstance, type Target } from "./config.js";
import { gatherDirectory, gatherDashboards, gitInfo } from "./gather.js";
import { lintDashboards, printLintReport } from "./lint.js";
import { missingEnvRefs, missingEnvHint } from "./shared/env-refs.js";
import { getAccessToken, login, tokenSource, type TokenSource } from "./oauth.js";
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

/**
 * Extra advice for a 401/403 from the server. The target resolved and the
 * request got through — it's the CREDENTIAL that's wrong — so point at the
 * thing that produced it rather than leaving "invalid or revoked token" as the
 * whole message.
 */
function authHint(status: number, t: Target, source: TokenSource): string {
  const login = `malloyyo login ${t.name}`;
  if (status === 403) {
    return `\n  The token is valid, but that account isn't an admin on ${t.url} —` +
      `\n  publishing is admin-only. Ask an admin there to grant access.`;
  }
  switch (source) {
    case "flag":
      return `\n  That token came from --token. Drop the flag and run:  ${login}`;
    case "env":
      return `\n  That token came from $${t.tokenEnv}. Re-issue it, or unset it and run:  ${login}`;
    default:
      return `\n  Your saved login for ${t.url} is expired or revoked.\n  Run:  ${login}`;
  }
}

/**
 * What to DO about a rejected push, by the server's `kind`. The server's own
 * message says what went wrong; this says where to fix it, since the same
 * Malloy error means something different depending on whether a file didn't
 * upload, a secret isn't set on that deployment, or the model is just wrong.
 */
function failureHint(out: ModelStatus, t: Target): string {
  switch (out.kind) {
    case "missing-import":
      return `\n  A file the model imports wasn't in the upload. Publish from the directory` +
        `\n  that holds index.malloy, and check the import path's spelling/case.`;
    case "connection":
      if (out.missingEnv?.length) {
        const vars = out.missingEnv.map((v) => `$${v}`).join(", ");
        return `\n  malloy-config.json references ${vars}, which ${out.missingEnv.length > 1 ? "are" : "is"} NOT set on ${t.url}.` +
          `\n  Secrets don't travel with the model — set them in that deployment's environment` +
          `\n  (Vercel: Settings → Environment Variables), then publish again.`;
      }
      return `\n  The server couldn't open the connection the model uses. Check the` +
        `\n  \`connections\` block in malloy-config.json, and that ${t.url} can reach it.`;
    case "persist":
      return `\n  The model itself is fine — this failed writing to the server's database.` +
        `\n  Retry; if it repeats, the message above is the database's own.`;
    default:
      return "";
  }
}

/** Message for a failed publish/status response, with advice about what to fix. */
function requestFailed(what: string, res: Response, out: ModelStatus, t: Target, source: TokenSource): Error {
  const detail = out.error ?? `${res.status} ${res.statusText}`;
  const hint =
    res.status === 401 || res.status === 403 ? authHint(res.status, t, source) : failureHint(out, t);
  return new Error(`${what} failed: ${detail}${hint}`);
}

async function publish(
  target: string,
  dir: string,
  opts: { token?: string; dryRun?: boolean; skipLint?: boolean; createDataset?: boolean },
): Promise<void> {
  const root = resolve(dir);
  const t = resolveTarget(root, target);
  const source = tokenSource(t, { tokenFlag: opts.token });
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
      // A lint failure whose real cause is an unset secret reads as an
      // inexplicable connection error — name the variable.
      throw new Error(
        "dashboard lint failed — fix the above, or pass --skip-lint" +
          missingEnvHint(missingEnvRefs(config), "this shell"),
      );
    }
  }

  const git = gitInfo(root);
  const dashboards = await gatherDashboards(root);
  const body: PublishRequest = { files, config, git, dashboards };

  const provenance = git.sha
    ? `${git.branch}@${shortSha(git.sha)}${git.dirty ? " (dirty)" : ""}`
    : "(no git)";
  console.log(`→ ${t.url}  dataset=${t.dataset}${opts.createDataset ? " (create if missing)" : ""}`);
  console.log(`  ${files.length} file(s)  ${provenance}`);

  if (opts.dryRun) {
    console.log("dry run — not sending");
    return;
  }

  // ?create=1 makes the server create the dataset when it doesn't exist yet — but
  // only after the model compiles, so a failed publish still creates nothing.
  const push = `${t.url}/api/datasets/${t.dataset}/model/push${opts.createDataset ? "?create=1" : ""}`;
  const res = await fetch(push, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as ModelStatus;

  if (!res.ok || !out.ok) {
    throw requestFailed("publish", res, out, t, source);
  }
  if (out.created) {
    console.log(`✓ created dataset ${out.dataset ?? t.dataset} (private) — ${t.url}/datasets/${out.dataset ?? t.dataset}`);
  }
  console.log(
    `✓ published version ${out.version} — ${out.sources?.length ?? 0} source(s)` +
      (dashboards.length ? `, ${dashboards.length} dashboard(s)` : ""),
  );
}

async function status(target: string, opts: { token?: string }): Promise<void> {
  const t = resolveTarget(resolve("."), target);
  const source = tokenSource(t, { tokenFlag: opts.token });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });
  const res = await fetch(`${t.url}/api/datasets/${t.dataset}/model/status`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    // Same treatment as publish: read the server's own message, and say what to
    // do about a bad credential instead of just printing "401 Unauthorized".
    const body = (await res.json().catch(() => ({}))) as ModelStatus;
    throw requestFailed("status", res, body, t, source);
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
  .option("--create-dataset", "create the target dataset if it doesn't exist yet (private)")
  .description('push the Malloy model in <dir> (default ".") to <target>')
  .action(publish);

program
  .command("lint")
  .argument("[dir]", "directory to lint", ".")
  .description("validate ./dashboards against the model (manifest, query, givens, Dashboard.tsx)")
  .action(async (dir: string) => {
    const root = resolve(dir);
    const report = await lintDashboards(root);
    if (report.dashboards.length === 0) {
      console.log("no dashboards to lint");
      return;
    }
    printLintReport(report);
    if (!report.ok) {
      // Same diagnosis publish gives: an unset {env:…} secret surfaces here as a
      // connection error with no hint of which variable is missing.
      const hint = missingEnvHint(missingEnvRefs(gatherDirectory(root).config), "this shell");
      if (hint) console.error(hint.replace(/^\n/, ""));
      process.exit(1);
    }
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
  .option("--analytics <id>", "GA4 Measurement ID, overriding malloyyo.analytics in malloy-config.json (bundle)")
  .option("--no-serve", "bundle only; don't serve the result (bundle)")
  .description("preview dashboards locally (dev), or build a static site from them (bundle)")
  .action(
    async (
      action: string,
      opts: { root?: string; port?: string; out?: string; title?: string; serve?: boolean; target?: string; duckdb?: string; analytics?: string },
    ) => {
      if (action === "dev") {
        await serveDashboard({ root: opts.root, port: Number(opts.port) });
        return;
      }
      if (action === "bundle") {
        if (opts.target !== "pages" && opts.target !== "vercel") {
          throw new Error(`unknown --target '${opts.target}' (expected: pages | vercel)`);
        }
        if (opts.analytics && !/^G-[A-Z0-9]+$/i.test(opts.analytics)) {
          throw new Error(
            `--analytics expects a GA4 Measurement ID like G-XXXXXXXXXX, got '${opts.analytics}'`,
          );
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
          analytics: opts.analytics,
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
