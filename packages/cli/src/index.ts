#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { resolveTarget } from "./config.js";
import { gatherDirectory, gitInfo } from "./gather.js";
import { getAccessToken, login } from "./oauth.js";
import { clearCreds } from "./store.js";
import type { PublishRequest, ModelStatus } from "./protocol.js";

const VERSION = "0.1.0";

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

async function loginCmd(target: string): Promise<void> {
  const t = resolveTarget(resolve("."), target);
  await login(t.url);
  console.log(`✓ logged in to ${t.name} (${t.url})`);
}

async function logoutCmd(target: string): Promise<void> {
  const t = resolveTarget(resolve("."), target);
  console.log(clearCreds(t.url) ? `✓ logged out of ${t.url}` : `not logged in to ${t.url}`);
}

const program = new Command();
program
  .name("malloyyo")
  .description("Publish Malloy models to a Malloyyo instance")
  .version(VERSION);

program
  .command("login")
  .argument("<target>", "named target from the `malloyyo` config block")
  .description("sign in to a target's instance in your browser (stores a token)")
  .action(loginCmd);

program
  .command("logout")
  .argument("<target>", "named target from the `malloyyo` config block")
  .description("forget the stored token for a target's instance")
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

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
