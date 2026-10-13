// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The lockdown, end to end: the real service against a fixture "app" whose
// /screenshot page tries to leave. Run with `npm test` (needs the headless
// shell: `npx playwright install --only-shell chromium`).
//
// Pins: only the app's origin is reached; the cloud metadata address and other
// hosts are refused and reported; the token rides on the page's own requests
// and on navigations, never on a fetch made by code inside the sandboxed
// dashboard iframe; the service key and the app's verdict on the token decide
// everything else.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const TOKEN = "tok-ok";
const KEY = "test-service-key-0123456789";
const seen = []; // [path, carriedToken]

const PAGE = `<!doctype html><html><body>
<h1>fixture dashboard</h1>
<div class="malloy-error-message">tile exploded</div>
<img src="https://example.com/leak.png">
<iframe sandbox="allow-scripts" src="/frame" style="height:100px"></iframe>
<script>
  fetch("/same").catch(() => {});
  fetch("https://example.com/leak").catch(() => {});
  fetch("http://169.254.169.254/latest/meta-data/").catch(() => {});
  try { new WebSocket("wss://example.com/socket"); } catch {}
</script>
</body></html>`;

const FRAME = `<!doctype html><html><body>frame
<script>fetch(${JSON.stringify("ORIGIN/from-frame")}).catch(() => {});</script>
</body></html>`;

let app;
let svc;
let svcUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  app = http.createServer((req, res) => {
    const carried = req.headers["x-malloyyo-screenshot"] === TOKEN;
    seen.push([req.url, carried]);
    if (req.url === "/screenshot") {
      if (!carried) return res.writeHead(404).end("no");
      return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    }
    if (req.url === "/frame") {
      const origin = `http://${req.headers.host}`;
      return res.writeHead(200, { "content-type": "text/html" }).end(FRAME.replace("ORIGIN", origin));
    }
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("ok");
  });
  const appPort = await listen(app);

  const probe = http.createServer();
  const svcPort = await listen(probe);
  probe.close();
  svcUrl = `http://127.0.0.1:${svcPort}`;
  svc = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, APP_ORIGIN: `http://127.0.0.1:${appPort}`, SCREENSHOT_SERVICE_KEY: KEY, PORT: String(svcPort), SETTLE_MS: "200" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (;;) {
    const [chunk] = await once(svc.stdout, "data");
    if (String(chunk).includes("screenshot service on")) break;
  }
});

after(() => {
  svc?.kill("SIGTERM");
  app?.close();
});

const render = (body, key = KEY) =>
  fetch(`${svcUrl}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

test("renders the app's page, refuses every other destination", async () => {
  const res = await render({ token: TOKEN });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.ok(out.png.length > 1000, "a PNG came back");

  const blocked = out.diagnostics.blockedRequests.join("\n");
  assert.match(blocked, /example\.com\/leak\.png/);
  assert.match(blocked, /example\.com\/leak/);
  assert.match(blocked, /169\.254\.169\.254/);
  assert.match(blocked, /wss:\/\/example\.com\/socket/);

  // An error the renderer drew in place of a tile, which it never logs.
  assert.deepEqual(out.diagnostics.renderErrors, ["tile exploded"]);
});

test("the token rides on the page's requests and navigations, not the sandboxed frame's fetches", () => {
  const carried = (path) => seen.filter(([p]) => p === path).map(([, c]) => c);
  assert.deepEqual(carried("/same"), [true]);
  assert.deepEqual(carried("/frame"), [true]);
  assert.deepEqual(carried("/from-frame"), [false]);
});

test("the service key is required", async () => {
  const res = await render({ token: TOKEN }, "wrong-key-wrong-key-wrong");
  assert.equal(res.status, 401);
});

test("a token the app refuses is an error, not a picture", async () => {
  const res = await render({ token: "nope" });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
});
