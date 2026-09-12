import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadCreds, saveCreds, type Creds } from "./store.js";
import { apiFetch } from "./http.js";
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

/** The scopes `malloyyo login` requests. Space-delimited, per RFC 6749 §3.3. */
const LOGIN_SCOPE = "mcp publish";

async function discover(baseUrl: string): Promise<Endpoints> {
  const res = await apiFetch(`${baseUrl}/api/oauth/discovery/authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed at ${baseUrl}: ${res.status} ${res.statusText}`);
  return (await res.json()) as Endpoints;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await apiFetch(registrationEndpoint, {
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

/** True where there is no browser to open: a container, a plain SSH session, CI.
    macOS and Windows always have one; Linux needs a display server. */
export function browserless(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "darwin" || platform === "win32") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    // A missing opener (`xdg-open` is absent from every slim Linux image) is
    // reported ASYNCHRONOUSLY, as an 'error' event — the try/catch around
    // spawn() never sees it, and an 'error' with no listener is rethrown by
    // Node as an uncaught exception that kills the CLI. That killed it one line
    // after printing the URL that is supposed to be the fallback. Listening is
    // the whole fix: we do not care why it failed, only that we survive it.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

/** Where the loopback redirect listener binds.

    The default — port 0 on 127.0.0.1 — is right on a workstation, where the
    browser and the CLI share a loopback interface and any free port will do.
    A container breaks both halves of that. The port has to be known in advance
    to be published (`docker run -p`, devcontainer `appPort`), and the forwarded
    connection then arrives on the container's own interface, not its loopback,
    so a listener bound to 127.0.0.1 inside the container refuses it. Set both:

        MALLOYYO_OAUTH_PORT=41121 MALLOYYO_OAUTH_HOST=0.0.0.0

    The redirect URI still names `localhost` in either case — that name is
    resolved by the browser, on whatever machine the browser is running. */
export function listenTarget(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const raw = env.MALLOYYO_OAUTH_PORT;
  let port = 0;
  if (raw !== undefined && raw !== "") {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`MALLOYYO_OAUTH_PORT must be a port number between 1 and 65535, got "${raw}"`);
    }
  }
  return { host: env.MALLOYYO_OAUTH_HOST || "127.0.0.1", port };
}

// Start the loopback listener (see `listenTarget`) and wait for the OAuth redirect.
function awaitRedirect(state: string): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  return new Promise((resolveServer, rejectServer) => {
    // Resolved first: a bad MALLOYYO_OAUTH_PORT should fail before there is a
    // timer or a socket to clean up.
    const { host, port: wanted } = listenTarget();
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

    let listening = false;

    // `listen` reports failure asynchronously too, so an unhandled 'error' here
    // would kill the CLI exactly the way the missing browser did. Port 0 could
    // hardly ever fail; a fixed MALLOYYO_OAUTH_PORT collides routinely.
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const detail =
        err.code === "EADDRINUSE"
          ? `${host}:${wanted} is already in use — set MALLOYYO_OAUTH_PORT to a free port`
          : err.message;
      const failure = new Error(`could not start the sign-in listener: ${detail}`);
      rejectCode(failure);
      if (!listening) {
        // Nothing is awaiting `code` yet, so its rejection would surface as an
        // unhandled rejection rather than as this call failing. Settle it, then
        // fail the call itself.
        void code.catch(() => {});
        rejectServer(failure);
      }
    });

    server.listen(wanted, host, () => {
      listening = true;
      const port = (server.address() as AddressInfo).port;
      // Clearing the timer on close matters on the failure paths: it is the
      // only pending handle once the server is shut, so leaving it armed keeps
      // the process alive for the full LOGIN_TIMEOUT_MS after an error.
      resolveServer({
        port,
        code,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

export interface LoginOptions {
  /** Print the URL instead of launching a browser. Implied where there is none. */
  noBrowser?: boolean;
}

/** Interactive browser login (Authorization Code + PKCE, loopback redirect). */
export async function login(baseUrl: string, opts: LoginOptions = {}): Promise<Creds> {
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
      // What this CLI does: publish models, and query them (`malloyyo mcp`
      // against a hosted instance). A claude.ai connection asks for "mcp"
      // alone and cannot publish — so a login here is not interchangeable
      // with one, and must say so.
      scope: LOGIN_SCOPE,
      state,
    }).toString();

    if (opts.noBrowser || browserless()) {
      console.log(`Visit this URL to sign in:\n\n  ${authUrl.toString()}\n`);
      if (!process.env.MALLOYYO_OAUTH_PORT) {
        // Worth saying before the wait rather than after the timeout: sign-in
        // will complete in the browser and then redirect to a port on THIS
        // machine that the browser cannot reach.
        console.log(
          "Note: sign-in redirects back to this machine on a random port.\n" +
            "  In a container, set MALLOYYO_OAUTH_PORT and MALLOYYO_OAUTH_HOST=0.0.0.0,\n" +
            "  and publish that port, so the browser can reach the redirect.\n",
        );
      }
      console.log("Waiting for sign-in to complete…");
    } else {
      console.log("Opening your browser to sign in…");
      console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    }

    const authCode = await code;

    const res = await apiFetch(ep.token_endpoint, {
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
    if (process.env[TOKEN_ENV]) {
      // Otherwise this reads as a successful login followed by inexplicable
      // 401s/403s from whatever that variable actually holds.
      console.log(
        `\nNote: $${TOKEN_ENV} is set in this shell and takes precedence over the\n` +
          `  login just stored. Unset it to use this login.`,
      );
    }
    return creds;
  } finally {
    close();
  }
}

async function refresh(baseUrl: string, creds: Creds): Promise<Creds> {
  const ep = await discover(baseUrl);
  const res = await apiFetch(ep.token_endpoint, {
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
 * The env var the CLI reads when the config names none: one token for "the
 * instance I work with", minted at <url>/settings/tokens.
 *
 * A target's own `malloyyo_token: { env: … }` still wins, because someone
 * pushing to main AND staging from one shell needs a credential per instance
 * and this single name can only hold one of them.
 */
export const TOKEN_ENV = "MALLOYYO_TOKEN";

/**
 * Is this value shaped like a token minted by a Malloyyo instance
 * (`myo_<instance>_<secret>`)? Used only to improve an auth failure's advice:
 * an env var that holds something else entirely — the classic case being a
 * warehouse secret that used to live under this name — otherwise produces a
 * bare "invalid token" with nothing pointing at the real cause. A token from
 * `malloyyo login` is not of this shape, which is why this never gates a
 * request.
 */
export function looksLikeInstanceToken(value: string): boolean {
  return /^myo_[a-z0-9]+_[A-Za-z0-9_-]{20,}$/.test(value);
}

/** Where a bearer token came from — decides what advice a 401 gets. */
export type TokenSource = "flag" | "env" | "global-env" | "login";

type Env = Record<string, string | undefined>;

/** The source getAccessToken WILL use, without resolving the token itself.
    Same precedence, so an auth failure can name the thing to fix. */
export function tokenSource(
  target: Target,
  opts: { tokenFlag?: string },
  env: Env = process.env,
): TokenSource {
  if (opts.tokenFlag) return "flag";
  if (target.tokenEnv && env[target.tokenEnv]) return "env";
  if (env[TOKEN_ENV]) return "global-env";
  return "login";
}

/**
 * Resolve a bearer token for a target. Precedence:
 *   1. --token flag
 *   2. the env var named in the config (per-instance, explicit)
 *   3. $MALLOYYO_TOKEN (the ambient one — what CI usually sets)
 *   4. stored `malloyyo login` credentials (auto-refreshed when near expiry)
 *
 * Both env vars sit ABOVE the stored login: a container has no credentials
 * file, and someone who exported a token in this shell meant it. The cost is
 * that a forgotten `export` in a shell profile shadows a fresh `malloyyo
 * login` — so `login` says when that variable is set, and every auth failure
 * names the source it actually used (tokenSource, above).
 */
export async function getAccessToken(
  target: Target,
  opts: { tokenFlag?: string },
  env: Env = process.env,
): Promise<string> {
  if (opts.tokenFlag) return opts.tokenFlag;
  if (target.tokenEnv && env[target.tokenEnv]) return env[target.tokenEnv] as string;
  const ambient = env[TOKEN_ENV];
  if (ambient) return ambient;

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
