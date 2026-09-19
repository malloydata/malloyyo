import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

// Tokens obtained via `malloyyo login`, keyed by instance URL so one machine can
// be logged in to several instances (main / staging / Guild) at once.
//
// Two kinds share the store: an OAuth grant from the browser flow (refreshable,
// so clientId + refreshToken), and a token pasted with `--token-stdin` — e.g.
// one an agent got from the instance's issue_cli_token tool — which has
// neither and simply expires.
export interface Creds {
  clientId?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

function credsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "malloyyo", "credentials.json");
}

function readAll(): Record<string, Creds> {
  const p = credsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, Creds>;
  } catch {
    return {};
  }
}

export function loadCreds(url: string): Creds | undefined {
  return readAll()[url];
}

export function saveCreds(url: string, creds: Creds): void {
  const p = credsPath();
  mkdirSync(dirname(p), { recursive: true });
  const all = readAll();
  all[url] = creds;
  writeFileSync(p, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // ensure perms even if the file pre-existed
  } catch {
    /* best effort */
  }
}

export function clearCreds(url: string): boolean {
  const all = readAll();
  if (!(url in all)) return false;
  delete all[url];
  writeFileSync(credsPath(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  return true;
}
