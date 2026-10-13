// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Malloyyo screenshot service: a headless browser that renders ONE Malloyyo
// origin and nothing else.
//
//   POST /render   Authorization: Bearer <SCREENSHOT_SERVICE_KEY>
//                  {"token": "<screenshot token minted by the app>"}
//   → {"ok": true, "png": "<base64>", "width", "height", "diagnostics": {…}}
//
// It is told only a token. It opens ${APP_ORIGIN}/screenshot, sending the
// token as a header; the app decides what that token may show. Every request
// and WebSocket the page opens to any other origin is refused. The page runs
// dashboard code written by members, so this process must hold no secrets and
// its network should reach nothing but the app (see README.md). Plain Node, no
// build step.

import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright";

const env = (name, fallback) => process.env[name] ?? fallback;
const int = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);

const APP_ORIGIN = (() => {
  const raw = env("APP_ORIGIN", "");
  try {
    return new URL(raw).origin;
  } catch {
    console.error("APP_ORIGIN must be the app's origin, e.g. https://malloyyo.example.com");
    process.exit(1);
  }
})();
const APP_HOST = new URL(APP_ORIGIN).host;
const KEY = env("SCREENSHOT_SERVICE_KEY", "");
if (KEY.length < 16) {
  console.error("SCREENSHOT_SERVICE_KEY must be set (16+ characters); the app sends it as a bearer token");
  process.exit(1);
}
const PORT = int("PORT", 3100);
const MAX_CONCURRENT = int("MAX_CONCURRENT", 2);
const MAX_QUEUED = int("MAX_QUEUED", 8);
const RENDER_TIMEOUT_MS = int("RENDER_TIMEOUT_MS", 30_000);
const SETTLE_MS = int("SETTLE_MS", 750);
const VIEWPORT = { width: int("VIEWPORT_WIDTH", 1280), height: int("VIEWPORT_HEIGHT", 1000) };
const MAX_HEIGHT = int("MAX_HEIGHT", 6000);
const TOKEN_HEADER = "x-malloyyo-screenshot";

// Plain HTTP on a name other than localhost (`http://app:3000` inside a
// compose network) is not a secure context, and the renderer's charts call
// crypto.randomUUID, which exists only in one — every chart fails. Supply it
// (from getRandomValues, which exists everywhere) before any page script runs.
// Chrome's --unsafely-treat-insecure-origin-as-secure would be the general fix,
// but the headless shell ignores it.
const INSECURE_ORIGIN =
  new URL(APP_ORIGIN).protocol === "http:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(APP_ORIGIN).hostname);
const RANDOM_UUID_POLYFILL = `if (globalThis.crypto && !crypto.randomUUID) {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  };
}`;

const LAUNCH_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--no-first-run",
  // WebRTC's UDP never passes through request routing; keep it from leaving at all.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

// ── the browser: one, launched at boot, relaunched if it dies ────────────────

let browser = null;
let sandboxed = false;

async function launch() {
  // Chrome's own sandbox when the container allows it (it needs user
  // namespaces); "auto" falls back without it and says so in /healthz.
  const mode = env("CHROMIUM_SANDBOX", "auto");
  const tries = mode === "0" ? [false] : mode === "1" ? [true] : [true, false];
  let lastErr;
  for (const sandbox of tries) {
    try {
      const b = await chromium.launch({ chromiumSandbox: sandbox, args: LAUNCH_ARGS });
      sandboxed = sandbox;
      if (!sandbox) console.warn("chromium is running WITHOUT its sandbox; rely on this container's isolation");
      b.on("disconnected", () => {
        browser = null;
      });
      return b;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function getBrowser() {
  if (!browser) browser = await launch();
  return browser;
}

// ── one render ───────────────────────────────────────────────────────────────

async function render(token) {
  const started = Date.now();
  const deadline = started + RENDER_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());
  const d = {
    timedOut: false,
    renderErrors: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    blockedRequests: [],
    durationMs: 0,
  };
  const cap = (list, s) => list.length < 50 && list.push(String(s).slice(0, 500));

  const context = await (await getBrowser()).newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    acceptDownloads: false,
  });
  try {
    if (INSECURE_ORIGIN) await context.addInitScript(RANDOM_UUID_POLYFILL);
    const page = await context.newPage();

    // The allowlist. Our origin passes; the token rides only on the page's own
    // requests and on navigations (the dashboard frame's document needs it) —
    // never on a fetch the sandboxed dashboard code makes itself.
    await context.route("**/*", (route) => {
      const req = route.request();
      let origin;
      try {
        origin = new URL(req.url()).origin;
      } catch {
        origin = "";
      }
      if (origin !== APP_ORIGIN) {
        cap(d.blockedRequests, req.url());
        return route.abort("blockedbyclient");
      }
      const carry = req.isNavigationRequest() || req.frame() === page.mainFrame();
      return route.continue(carry ? { headers: { ...req.headers(), [TOKEN_HEADER]: token } } : undefined);
    });
    // WebSockets get the same allowlist: the app's own host only (a production
    // build opens none; `next dev` needs its HMR socket to load the page).
    await context.routeWebSocket(/.*/, (ws) => {
      let host = "";
      try {
        host = new URL(ws.url()).host;
      } catch {
        /* unparseable: refused below */
      }
      if (host === APP_HOST) return ws.connectToServer();
      cap(d.blockedRequests, ws.url());
      return ws.close();
    });

    page.on("console", (msg) => msg.type() === "error" && cap(d.consoleErrors, msg.text()));
    page.on("pageerror", (err) => cap(d.pageErrors, err.message));
    page.on("requestfailed", (req) => {
      const why = req.failure()?.errorText ?? "failed";
      if (!why.includes("BLOCKED_BY_CLIENT")) cap(d.failedRequests, `${req.method()} ${req.url()}: ${why}`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) cap(d.failedRequests, `${res.request().method()} ${res.url()}: HTTP ${res.status()}`);
    });

    const first = await page.goto(`${APP_ORIGIN}/screenshot`, { waitUntil: "load", timeout: left() });
    if (!first || first.status() >= 400) {
      return { ok: false, status: 404, error: "the app refused the token, or the dashboard was not found" };
    }

    // Done = no requests for a moment (every dashboard query is a request),
    // then a short settle for charts to draw.
    try {
      await page.waitForLoadState("networkidle", { timeout: left() });
    } catch {
      d.timedOut = true;
    }
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(Math.min(SETTLE_MS, left()));

    // A custom dashboard draws inside a fixed-height iframe that scrolls; a
    // picture of that box would cut it off. Grow each frame to its content.
    let grew = false;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const h = await frame.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      const el = await frame.frameElement().catch(() => null);
      if (h > 0 && el) {
        grew = (await el.evaluate((e, h) => {
          const before = e.getBoundingClientRect().height;
          e.style.height = `${h}px`;
          return h > before;
        }, Math.min(h, MAX_HEIGHT))) || grew;
      }
    }
    if (grew) await page.waitForTimeout(Math.min(SETTLE_MS, left()));

    // Errors the renderer draws into the page instead of logging: a tile that
    // failed shows its message in place and says nothing to the console.
    for (const frame of page.frames()) {
      const shown = await frame
        .evaluate(() => [...document.querySelectorAll(".malloy-error-message")].map((e) => e.textContent?.trim() ?? ""))
        .catch(() => []);
      for (const msg of shown) if (msg) cap(d.renderErrors, msg);
    }

    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.max(VIEWPORT.height, Math.min(full, MAX_HEIGHT));
    const png = await page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height },
      timeout: left(),
    });
    d.durationMs = Date.now() - started;
    return { ok: true, png: png.toString("base64"), width: VIEWPORT.width, height, diagnostics: d };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── admission: a few at a time, a short queue, then 429 ──────────────────────

let running = 0;
const waiting = [];

async function admitted(fn) {
  if (running >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) return { ok: false, status: 429, error: "busy; try again shortly" };
    await new Promise((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function authorized(req) {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, 200, { ok: true, browser: browser?.isConnected() ?? false, sandboxed, running, queued: waiting.length });
    }
    if (req.method !== "POST" || req.url !== "/render") return send(res, 404, { ok: false, error: "not found" });
    if (!authorized(req)) return send(res, 401, { ok: false, error: "unauthorized" });
    const body = await readJson(req);
    if (typeof body?.token !== "string" || body.token.length > 8192) {
      return send(res, 400, { ok: false, error: "body must be {\"token\": \"…\"}" });
    }
    const out = await admitted(() => render(body.token));
    const { status, ...rest } = out;
    return send(res, out.ok ? 200 : (status ?? 500), rest);
  } catch (err) {
    return send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

await getBrowser();
server.listen(PORT, () => {
  console.log(`screenshot service on :${PORT} → ${APP_ORIGIN} (sandboxed: ${sandboxed})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close();
    browser?.close().finally(() => process.exit(0));
  });
}
