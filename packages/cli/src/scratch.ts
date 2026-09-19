// Scratch dashboards from the command line: build a dashboard as files in a
// model checkout and push it to an instance, which stores it as a draft,
// test-runs its queries, and serves it at a URL. Nothing in the dataset's
// published model changes.
//
// Built for an agent (Claude Code) as much as a person: the agent gets a
// short-lived token from the instance's MCP `issue_cli_token` tool, stores it
// with `malloyyo login <url> --token-stdin`, and then edits files and pushes,
// looking at the returned URL in its own browser.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePublishTarget } from "./config.js";
import { apiFetch } from "./http.js";
import { getAccessToken } from "./oauth.js";
import { saveCreds } from "./store.js";

/** Read all of stdin — how a token arrives without landing in `ps` or shell history. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("--token-stdin reads the token from stdin — pipe it in:  printf '%s' \"$TOKEN\" | malloyyo login <url> --token-stdin");
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

interface WhoAmI {
  ok: boolean;
  error?: string;
  email?: string;
  instance?: string;
  scopes?: string[];
  expiresAt?: string | null;
}

/**
 * `malloyyo login <url> --token-stdin`: store a token for <url> after checking
 * that <url> accepts it. The check is the point — the URL is what identifies
 * an instance (a local dev server can share production's token prefix), so a
 * token for the wrong instance fails here, not on the first real command.
 */
export async function loginWithToken(url: string): Promise<void> {
  const token = await readStdin();
  if (!token) throw new Error("no token on stdin");
  const res = await apiFetch(`${url}/api/cli/whoami`, { headers: { authorization: `Bearer ${token}` } });
  const me = (await res.json().catch(() => ({ ok: false }))) as WhoAmI;
  if (!res.ok || !me.ok) {
    throw new Error(
      `${url} did not accept that token: ${me.error ?? `${res.status} ${res.statusText}`}\n` +
        `  Is it from this instance? Tokens are per instance URL.`,
    );
  }
  // No expiry means a personal token minted without one — keep it for a year.
  const expiresAt = me.expiresAt ? Date.parse(me.expiresAt) : Date.now() + 365 * 86400_000;
  saveCreds(url, { accessToken: token, expiresAt });
  const until = me.expiresAt ? `, expires ${new Date(expiresAt).toLocaleString()}` : "";
  console.log(`✓ logged in to ${url} as ${me.email} (${(me.scopes ?? []).join(", ")}${until})`);
}

// ── scratch push ─────────────────────────────────────────────────────────────

interface TileReport {
  run: string;
  ok: boolean;
  rowCount?: number;
  columns?: string[];
  error?: string;
}

interface PushResult {
  ok: boolean;
  error?: string;
  problems?: Array<{ message: string; code?: string }>;
  slug?: string;
  dashboard?: string;
  title?: string;
  url?: string;
  tiles?: TileReport[];
  component?: { ok: boolean; error?: string; line?: number };
}

/** Which slug a (instance, dataset, dashboard) last pushed to, so re-pushing
    updates the same draft — one stable URL to keep looking at. Local state,
    kept out of git. */
function statePath(root: string): string {
  return join(root, ".malloyyo", "scratch.json");
}

function readState(root: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeState(root: string, state: Record<string, string>): void {
  const dir = join(root, ".malloyyo");
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n");
}

function readComponent(root: string, name: string): string {
  for (const ext of ["tsx", "jsx"]) {
    const p = join(root, "dashboards", `${name}.${ext}`);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

export async function scratchPush(
  name: string,
  dir: string,
  opts: { instance?: string; dataset?: string; token?: string; new?: boolean; title?: string },
): Promise<void> {
  const root = resolve(dir);
  const malloyPath = join(root, "dashboards", `${name}.malloy`);
  const malloy = existsSync(malloyPath) ? readFileSync(malloyPath, "utf8") : "";
  const source = readComponent(root, name);
  if (!malloy && !source) {
    throw new Error(
      `nothing to push: expected dashboards/${name}.tsx (or .jsx), dashboards/${name}.malloy, or both, under ${root}`,
    );
  }
  const t = resolvePublishTarget(root, undefined, { instance: opts.instance, dataset: opts.dataset });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });

  const key = `${t.url} ${t.dataset} ${name}`;
  const state = readState(root);
  const slug = opts.new ? undefined : state[key];

  const res = await apiFetch(`${t.url}/api/datasets/${encodeURIComponent(t.dataset)}/scratch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name, malloy, source, title: opts.title, slug }),
  });
  const out = (await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))) as PushResult;

  if (!out.ok) {
    const problems = (out.problems ?? []).map((p) => `\n  - ${p.message}`).join("");
    const auth =
      res.status === 401 || res.status === 403
        ? `\n  Get a token for ${t.url} (its issue_cli_token tool) and run:  malloyyo login ${t.url} --token-stdin`
        : "";
    throw new Error(`scratch push failed: ${out.error ?? res.status}${problems}${auth}`);
  }

  state[key] = out.slug!;
  writeState(root, state);

  console.log(`✓ ${slug ? "updated" : "saved"} '${out.title}' → ${out.url}`);
  for (const tile of out.tiles ?? []) {
    console.log(
      // The server test-runs a few rows only, so the count is not the result's
      // size — but zero is worth saying: it's an empty chart.
      !tile.ok
        ? `  ✗ ${tile.run} — ${tile.error}`
        : tile.rowCount === 0
          ? `  ! ${tile.run} — ran, but returned no rows`
          : `  ✓ ${tile.run} — ran${tile.columns?.length ? `: ${tile.columns.join(", ")}` : ""}`,
    );
  }
  if (out.component && !out.component.ok) {
    console.log(`  ✗ component${out.component.line ? ` (line ${out.component.line})` : ""}: ${out.component.error}`);
  }
  const failed = (out.tiles ?? []).some((t) => !t.ok) || (out.component && !out.component.ok);
  if (failed) process.exitCode = 1;
}
