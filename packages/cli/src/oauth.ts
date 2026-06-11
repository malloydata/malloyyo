import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadCreds, saveCreds, type Creds } from "./store.js";
import type { Target } from "./config.js";

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenGrant {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function discover(baseUrl: string): Promise<Endpoints> {
  const res = await fetch(`${baseUrl}/api/oauth/discovery/authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed at ${baseUrl}: ${res.status} ${res.statusText}`);
  return (await res.json()) as Endpoints;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "malloyyo CLI",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    }),
  });
  if (!res.ok) throw new Error(`client registration failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* fall back to the printed URL */
  }
}

// Start a loopback listener on a random free port and wait for the OAuth redirect.
function awaitRedirect(state: string): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  return new Promise((resolveServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const timer = setTimeout(() => rejectCode(new Error("timed out waiting for browser sign-in")), LOGIN_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      const ok = !err && !!got && u.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center">` +
          `<h2>${ok ? "✓ Signed in to malloyyo" : "Sign-in failed"}</h2>` +
          `<p>${ok ? "You can close this tab and return to the terminal." : (err ?? "state mismatch")}</p></body>`,
      );
      clearTimeout(timer);
      if (ok) resolveCode(got);
      else rejectCode(new Error(err ?? "state mismatch or missing code"));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveServer({ port, code, close: () => server.close() });
    });
  });
}

/** Interactive browser login (Authorization Code + PKCE, loopback redirect). */
export async function login(baseUrl: string): Promise<Creds> {
  const ep = await discover(baseUrl);
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("base64url");

  const { port, code, close } = await awaitRedirect(state);
  try {
    const redirectUri = `http://localhost:${port}/callback`;
    const clientId = await registerClient(ep.registration_endpoint, redirectUri);

    const authUrl = new URL(ep.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state,
    }).toString();

    console.log("Opening your browser to sign in…");
    console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());

    const authCode = await code;

    const res = await fetch(ep.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    const grant = (await res.json()) as TokenGrant;

    const creds: Creds = {
      clientId,
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: Date.now() + (grant.expires_in ?? 86400) * 1000,
    };
    saveCreds(baseUrl, creds);
    return creds;
  } finally {
    close();
  }
}

async function refresh(baseUrl: string, creds: Creds): Promise<Creds> {
  const ep = await discover(baseUrl);
  const res = await fetch(ep.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  const grant = (await res.json()) as TokenGrant;
  const updated: Creds = {
    clientId: creds.clientId,
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token,
    expiresAt: Date.now() + (grant.expires_in ?? 86400) * 1000,
  };
  saveCreds(baseUrl, updated);
  return updated;
}

/**
 * Resolve a bearer token for a target. Precedence:
 *   1. --token flag
 *   2. the env var named in the config (CI / explicit)
 *   3. stored `malloyyo login` credentials (auto-refreshed when near expiry)
 */
export async function getAccessToken(target: Target, opts: { tokenFlag?: string }): Promise<string> {
  if (opts.tokenFlag) return opts.tokenFlag;
  if (target.tokenEnv && process.env[target.tokenEnv]) return process.env[target.tokenEnv] as string;

  let creds = loadCreds(target.url);
  if (!creds) {
    throw new Error(`Not authenticated for ${target.url}.\nRun:  malloyyo login ${target.name}`);
  }
  if (creds.expiresAt - Date.now() < 60_000) {
    try {
      creds = await refresh(target.url, creds);
    } catch {
      throw new Error(`Session expired for ${target.url}.\nRun:  malloyyo login ${target.name}`);
    }
  }
  return creds.accessToken;
}
