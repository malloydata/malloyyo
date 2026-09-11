import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadCreds, saveCreds, type Creds } from "./store.js";
import { apiFetch, UpgradeRequiredError } from "./http.js";
import type { Target } from "./config.js";

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  /** Present only on instances that support the device flow. Whether the CLI
      WANTS that flow is decided client-side (see chooseFlow); this only says
      whether the server can serve it. */
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
}

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenGrant {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

/** Register a client for ONE flow, not both.

    Registration records which grants a client may use, and the server checks
    them at /authorize and at every token-endpoint handler. So a device-flow
    client asks only for the device grant: the redirect URI it must still supply
    (registration requires a non-empty list) can then never be used to obtain a
    code, because `authorization_code` is not among its grants. Registering both
    would leave a redirect enabled that this client never intends to use. */
async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  kind: "loopback" | "device" = "loopback",
): Promise<string> {
  const grantTypes =
    kind === "device"
      ? [DEVICE_GRANT_TYPE, "refresh_token"]
      : ["authorization_code", "refresh_token"];
  const res = await apiFetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "malloyyo CLI",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
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
  env: Record<string, string | undefined> = process.env,
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
/** `env` is narrowed to what this actually reads rather than NodeJS.ProcessEnv:
    the server tsconfig augments that type with required keys (NODE_ENV), so a
    test passing a bare `{}` fails a root typecheck even though the function only
    ever looks at two optional strings. */
export function listenTarget(env: Record<string, string | undefined> = process.env): { host: string; port: number } {
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
  /** Use the device flow (`--device`) even where a loopback redirect would work. */
  device?: boolean;
}

export type LoginFlow = "device" | "loopback";

/** Which flow to run. Decided here, by the client, because only the client
    knows whether a redirect to `localhost` can reach it.

    The loopback redirect is the better experience wherever it works — the
    consent page completes the sign-in on its own, nothing to transcribe — and it
    works wherever the browser and the CLI share a machine. The device flow is
    for the cases where they do not (a Codespace, a remote container, SSH), or
    where there is no browser to open at all. RFC 8628 calls those
    "input-constrained" clients; a laptop is not one, whatever the server
    advertises.

    Precedence: `--device` always wins; a pinned MALLOYYO_OAUTH_PORT means the
    user has arranged for the redirect to reach them, so honour it; otherwise a
    machine with no browser gets the device flow and everything else the
    loopback. */
export function chooseFlow(
  opts: LoginOptions,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): LoginFlow {
  if (opts.device) return "device";
  if (env.MALLOYYO_OAUTH_PORT) return "loopback";
  return browserless(platform, env) ? "device" : "loopback";
}

/** RFC 8628 §3.5 responses that end the poll. Anything else the token endpoint
    says is either `authorization_pending` / `slow_down` (keep going) or noise. */
const TERMINAL_DEVICE_ERRORS: Record<string, string> = {
  access_denied: "sign-in was denied",
  expired_token: "the code expired before it was approved — run login again",
  invalid_grant: "the server no longer recognises this sign-in attempt — run login again",
  invalid_client: "the server no longer recognises this CLI registration — run login again",
  unauthorized_client: "this CLI registration is not allowed to use the device flow",
};

/** What the poll loop needs from the outside world, so a test can script it. */
export interface PollDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Told once, the first time a poll fails for a reason that is not the
      protocol — so a user watching a silent terminal knows it is retrying. */
  warn: (message: string) => void;
}

const defaultPollDeps: PollDeps = {
  fetch: apiFetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  warn: (m) => console.log(m),
};

/** Poll the token endpoint until the human decides, the code expires, or the
    server says the attempt is over.

    Two kinds of non-success come back here and they must not be confused. The
    protocol ones — `authorization_pending`, `slow_down`, and the terminal set
    above — are the server speaking RFC 8628, and are honoured exactly. Everything
    else is the road between here and the server: a 502 with an HTML body from a
    forwarding proxy, a reset connection, a gateway timeout. This loop runs for
    up to ten minutes in precisely the environments where that road is least
    reliable (a Codespace, a container behind a port forwarder), after the user
    has already been told to go type a code; ending the whole sign-in over one
    bad hop would make them start again. Those are retried on the same interval
    until `expires_in` runs out. A 4xx carrying an error this loop does not know
    is treated as the server's final word. */
export async function pollDeviceToken(
  tokenEndpoint: string,
  clientId: string,
  auth: Pick<DeviceAuthorization, "device_code" | "expires_in" | "interval">,
  deps: Partial<PollDeps> = {},
): Promise<TokenGrant> {
  const d: PollDeps = { ...defaultPollDeps, ...deps };
  // The server advertises the minimum gap; polling faster earns `slow_down`.
  let intervalMs = (auth.interval ?? 5) * 1000;
  const deadline = d.now() + auth.expires_in * 1000;
  let warned = false;
  const transient = (what: string): void => {
    if (warned) return;
    warned = true;
    d.warn(`(${what} — still waiting, will keep trying until the code expires)`);
  };

  for (;;) {
    if (d.now() >= deadline) throw new Error("timed out waiting for approval");
    await d.sleep(intervalMs);

    let res: Response;
    try {
      res = await d.fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: auth.device_code,
          client_id: clientId,
        }),
      });
    } catch (e) {
      // "Upgrade the CLI" is not going to change by waiting.
      if (e instanceof UpgradeRequiredError) throw e;
      transient(`could not reach the server: ${(e as Error).message}`);
      continue;
    }
    const body = (await res.json().catch(() => null)) as (Partial<TokenGrant> & { error?: string }) | null;

    if (res.ok && body?.access_token && body.refresh_token) {
      return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in };
    }

    // Not the protocol: a non-JSON body, a body with no error code, or a server
    // error. None of these is the server deciding anything about this sign-in.
    if (!body?.error || res.status >= 500) {
      transient(`the server answered ${res.status} ${res.statusText}`.trim());
      continue;
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      default: {
        const known = TERMINAL_DEVICE_ERRORS[body.error];
        throw new Error(known ? known : `sign-in failed: ${body.error}`);
      }
    }
  }
}

/** Device flow (RFC 8628): print a URL and a short code, then poll. Nothing
    listens, so this is the only variant that works where the browser and the CLI
    are on different machines — a Codespace, a remote container, CI — and it needs
    no published port even when they are on the same one. */
async function deviceLogin(baseUrl: string, ep: Endpoints, opts: LoginOptions): Promise<Creds> {
  // Registration demands a redirect URI even though this flow has none. Supply a
  // loopback placeholder; it is inert because this client is not registered for
  // the authorization_code grant, and the server refuses /authorize to a client
  // that is not.
  const clientId = await registerClient(
    ep.registration_endpoint,
    "http://localhost/unused-by-device-flow",
    "device",
  );

  const start = await apiFetch(ep.device_authorization_endpoint as string, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: "mcp" }),
  });
  if (!start.ok) {
    throw new Error(`device authorization failed: ${start.status} ${await start.text()}`);
  }
  const auth = (await start.json()) as DeviceAuthorization;

  console.log(`\nTo sign in, visit:\n\n  ${auth.verification_uri}\n`);
  console.log(`and enter this code:\n\n  ${auth.user_code}\n`);
  // Offered, never opened for you: a link carrying the code is the phishing
  // vector the code is supposed to defend against. Typing it is the check.
  if (!opts.noBrowser && !browserless()) openBrowser(auth.verification_uri);
  console.log("Waiting for approval…");

  const grant = await pollDeviceToken(ep.token_endpoint, clientId, auth);
  const creds: Creds = {
    clientId,
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token,
    expiresAt: Date.now() + (grant.expires_in ?? 86400) * 1000,
  };
  saveCreds(baseUrl, creds);
  return creds;
}

/** Interactive login. The flow is chosen client-side (chooseFlow); the server's
    discovery document only says whether the device flow is available. Where the
    device flow is wanted but the instance is too old to offer it, `--device` is
    an error and the inferred case falls back to the loopback redirect with a
    note about the port it needs. */
export async function login(baseUrl: string, opts: LoginOptions = {}): Promise<Creds> {
  const ep = await discover(baseUrl);
  const wanted = chooseFlow(opts);
  if (wanted === "device") {
    if (ep.device_authorization_endpoint) return deviceLogin(baseUrl, ep, opts);
    if (opts.device) {
      throw new Error(
        `${baseUrl} does not support the device flow (it is too old to advertise it).\n` +
          "Sign in with the loopback redirect instead: drop --device, and in a container set\n" +
          "MALLOYYO_OAUTH_PORT and MALLOYYO_OAUTH_HOST=0.0.0.0 and publish that port.",
      );
    }
  }
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

/** Where a bearer token came from — decides what advice a 401 gets. */
export type TokenSource = "flag" | "env" | "login";

/** The source getAccessToken WILL use, without resolving the token itself.
    Same precedence, so an auth failure can name the thing to fix. */
export function tokenSource(target: Target, opts: { tokenFlag?: string }): TokenSource {
  if (opts.tokenFlag) return "flag";
  if (target.tokenEnv && process.env[target.tokenEnv]) return "env";
  return "login";
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
