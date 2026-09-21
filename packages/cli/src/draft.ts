// Draft dashboards from the command line: build a dashboard as files in a
// model checkout and push it to an instance, which stores it as a draft,
// test-runs its queries, and serves it at a URL. Nothing in the dataset's
// published model changes.
//
// Built for an agent (Claude Code) as much as a person: the agent gets a
// short-lived token from the instance's MCP `issue_cli_token` tool, stores it
// with `malloyyo login <url> --token-stdin`, and then edits files and pushes,
// looking at the returned URL in its own browser.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePublishTarget, type Target } from "./config.js";
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

// ── list ─────────────────────────────────────────────────────────────────────

interface DraftSummary {
  slug: string;
  dashboard: string;
  name: string;
  title: string;
  updatedAt: string;
  hasComponent: boolean;
  hasMalloy: boolean;
  promotedAs: string | null;
}

/** An HTTP failure from the instance, carrying the status so a caller can tell
    "not yours" from "gone" without matching on prose. */
class DraftRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function draftFetch<T>(t: Target, path: string, bearer: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`${t.url}/api/datasets/${encodeURIComponent(t.dataset)}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${bearer}` },
  });
  const out = (await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))) as
    | ({ ok: true } & T)
    | { ok: false; error?: string };
  if (!out.ok) {
    // 403 is two different things: a credential that cannot act here, and a
    // draft that is someone else's. Only the first is worth a login hint.
    const auth =
      res.status === 401
        ? `\n  Get a token for ${t.url} (its issue_cli_token tool) and run:  malloyyo login ${t.url} --token-stdin`
        : "";
    throw new DraftRequestError(`${out.error ?? res.status}${auth}`, res.status);
  }
  return out as T;
}

export async function draftList(
  dir: string,
  opts: { instance?: string; dataset?: string; token?: string },
): Promise<void> {
  const t = resolvePublishTarget(resolve(dir), undefined, { instance: opts.instance, dataset: opts.dataset });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });
  const { drafts } = await draftFetch<{ drafts: DraftSummary[] }>(t, "/drafts", bearer);
  if (drafts.length === 0) {
    console.log(`no drafts on ${t.dataset} at ${t.url}`);
    return;
  }
  for (const d of drafts) {
    const files = [d.hasMalloy ? ".malloy" : null, d.hasComponent ? "component" : null].filter(Boolean).join(" + ");
    const promoted = d.promotedAs ? `  → promoted as ${d.promotedAs}` : "";
    console.log(`${d.slug}  ${d.title}  (${files}, ${d.updatedAt.slice(0, 10)})${promoted}`);
  }
}

// ── promote ──────────────────────────────────────────────────────────────────

interface DraftFiles extends DraftSummary {
  malloy: string;
  source: string;
  inline: string[];
}

/** The .malloy a component-only draft needs, with its inline queries carried
    over as comments for whoever finishes the promotion. Deliberately not a
    mechanical rewrite: naming the queries, and deciding between one query and
    a tiled dashboard, is the judgement promotion exists to apply. */
function malloyScaffold(name: string, title: string, inline: string[]): string {
  const candidates = inline.length
    ? inline.map((q) => q.split("\n").map((line) => `//   ${line}`).join("\n")).join("\n//\n")
    : "//   (none found — the component builds its queries at runtime)";
  return `import "../index.malloy"

// TODO promote: name each query below, then point the component at it with
// useQuery({ query: "<name>" }). A repo dashboard's queries live here, not in
// its component. See yo_help "dashboards/authoring".
//
// From ${name}'s component:
${candidates}

# artifact { title="${title.replace(/"/g, '\\"')}" }
// query: ${name} is <source> -> { ... }
`;
}

export async function draftPromote(
  slug: string,
  dir: string,
  opts: { instance?: string; dataset?: string; token?: string; name?: string; tsx?: boolean; force?: boolean },
): Promise<void> {
  const root = resolve(dir);
  const t = resolvePublishTarget(root, undefined, { instance: opts.instance, dataset: opts.dataset });
  const bearer = await getAccessToken(t, { tokenFlag: opts.token });
  const { draft } = await draftFetch<{ draft: DraftFiles }>(t, `/drafts/${encodeURIComponent(slug)}`, bearer);

  // The filename IS the dashboard's identity in the repo: its URL, its
  // `# drill { to= }` target, and the component's basename. A draft's own name
  // was checked when it was saved; --name is checked here, so a stray path
  // cannot write outside dashboards/.
  const name = opts.name ?? draft.name;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error(`--name must be letters, digits, '-' or '_' (a dashboard's file basename), not "${name}"`);
  }
  const dashboards = join(root, "dashboards");
  mkdirSync(dashboards, { recursive: true });

  const written: Array<{ path: string; content: string }> = [];
  const malloyPath = join(dashboards, `${name}.malloy`);
  const componentPath = join(dashboards, `${name}.${opts.tsx ? "tsx" : "jsx"}`);
  const existing = [malloyPath, componentPath].filter((p) => existsSync(p));
  if (existing.length > 0 && !opts.force) {
    throw new Error(
      `${existing.map((p) => p.replace(`${root}/`, "")).join(", ")} already exist(s) — ` +
        `pass --name to promote under another name, or --force to overwrite`,
    );
  }

  const malloy = draft.malloy.trim() ? draft.malloy : malloyScaffold(name, draft.title, draft.inline);
  written.push({ path: malloyPath, content: malloy });
  if (draft.source.trim()) written.push({ path: componentPath, content: draft.source });

  // Record BEFORE writing: a token that lapsed between the read and here would
  // otherwise leave files in the checkout that the instance knows nothing
  // about, and a retry would then refuse to overwrite them.
  const hash = createHash("sha256");
  for (const f of written) hash.update(f.content).update("\0");
  let unrecorded = "";
  try {
    await draftFetch(t, `/drafts/${encodeURIComponent(slug)}`, bearer, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, hash: hash.digest("hex").slice(0, 16) }),
    });
  } catch (e) {
    // Someone else's draft: the files are still worth having — that is how a
    // colleague moves a draft into the repo — but its author's row is theirs.
    if (e instanceof DraftRequestError && e.status === 403) unrecorded = e.message;
    else throw e;
  }

  for (const f of written) writeFileSync(f.path, f.content.endsWith("\n") ? f.content : `${f.content}\n`);

  console.log(`✓ promoted '${draft.title}' into ${root.replace(process.env.HOME ?? "", "~")}`);
  for (const f of written) console.log(`  ${f.path.replace(`${root}/`, "")}`);
  console.log(`  the draft stays live at ${t.url}/datasets/${t.dataset}/dashboard/${draft.dashboard}`);
  if (unrecorded) console.log(`  (not recorded on the draft: ${unrecorded})`);
  if (!draft.malloy.trim()) {
    console.log(
      `\nNext: lift ${draft.inline.length || "the"} inline quer${draft.inline.length === 1 ? "y" : "ies"} out of ` +
        `dashboards/${name}.${opts.tsx ? "tsx" : "jsx"} into dashboards/${name}.malloy as named queries, point the ` +
        `component at them with useQuery({ query: "<name>" }), then run:  malloyyo lint`,
    );
  } else {
    console.log(`\nNext:  malloyyo lint`);
  }
}
