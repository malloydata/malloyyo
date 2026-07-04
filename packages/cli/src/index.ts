#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { resolveTarget, resolveInstance } from "./config.js";
import { gatherDirectory, gitInfo } from "./gather.js";
import { getAccessToken, login } from "./oauth.js";
import { serveMcp } from "./mcp.js";
import { serveDashboard } from "./dashboard.js";
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
  opts: { token?: string; dryRun?: boolean },
): Promise<void> {
  const root = resolve(dir);
  const t = resolveTarget(root, target);
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });

  const { files, config } = gatherDirectory(root);
  if (files.length === 0) {
    throw new Error(`No .malloy files found under ${root}`);
  }
  const git = gitInfo(root);
  const body: PublishRequest = { files, config, git };

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
  console.log(`✓ published version ${out.version} — ${out.sources?.length ?? 0} source(s)`);
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
  .description('push the Malloy model in <dir> (default ".") to <target>')
  .action(publish);

program
  .command("status")
  .argument("<target>", "named target from the `malloyyo` config block")
  .option("--token <token>", "bearer token (overrides login/env)")
  .description("show what's live on <target>: version, commit, compile state")
  .action(status);

program
  .command("mcp")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .description(
    "run a local stdio MCP server (the explore / test-window surface) over the " +
      "Malloy model in the current directory",
  )
  .action(async (opts: { root?: string }) => {
    await serveMcp({ root: opts.root, version: VERSION });
  });

program
  .command("dashboard")
  .argument("<action>", "action to run (currently: dev)")
  .option("-C, --root <dir>", "project root (default: current directory)")
  .option("-p, --port <port>", "port to serve on", "4173")
  .description("preview dashboard artifacts in ./dashboards against the local Malloy model")
  .action(async (action: string, opts: { root?: string; port?: string }) => {
    if (action !== "dev") throw new Error(`unknown dashboard action '${action}' (expected: dev)`);
    await serveDashboard({ root: opts.root, port: Number(opts.port) });
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
