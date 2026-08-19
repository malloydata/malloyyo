// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The origin this instance hands out must not be attacker-choosable.
//
// `originFromRequest` feeds the OAuth discovery documents (`issuer`,
// `authorization_endpoint`, `token_endpoint`), the `WWW-Authenticate:
// resource_metadata="…"` header on /mcp 401s, the sign-in/consent redirects,
// and `/ltool/<slug>` share links handed to MCP clients. It used to read
// `X-Forwarded-Host` with no allow-list, which is caller-chosen behind any
// proxy that doesn't overwrite it — Fly, Railway, Coolify, plain nginx, i.e.
// every deployment of the committed Dockerfile. These tests pin the rule that
// `APP_BASE_URL` wins whenever it is set.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseUrlStartupError, configuredOrigin, originFromRequest } from "./oauth/base-url.js";

const SAVED = { APP_BASE_URL: process.env.APP_BASE_URL, NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL };
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const spoofed = (headers: Record<string, string>) =>
  new Request("https://real.example/.well-known/oauth-authorization-server", { headers });

test("APP_BASE_URL wins over a spoofed X-Forwarded-Host", () => {
  process.env.APP_BASE_URL = "https://real.example";
  const origin = originFromRequest(spoofed({ "x-forwarded-host": "evil.example" }));
  assert.equal(origin, "https://real.example");
});

test("APP_BASE_URL wins over a spoofed host AND proto together", () => {
  process.env.APP_BASE_URL = "https://real.example";
  const origin = originFromRequest(
    spoofed({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", host: "evil.example" }),
  );
  assert.equal(origin, "https://real.example");
});

test("a trailing slash or path in APP_BASE_URL is normalized away", () => {
  // Otherwise every derived URL would carry it: `https://x//ltool/abc`, and an
  // `issuer` that no longer matches what the client registered.
  for (const raw of ["https://real.example/", "https://real.example/base/path", "  https://real.example  "]) {
    process.env.APP_BASE_URL = raw;
    assert.equal(configuredOrigin(), "https://real.example", `for ${JSON.stringify(raw)}`);
  }
});

test("a non-standard port is preserved", () => {
  process.env.APP_BASE_URL = "https://real.example:8443";
  assert.equal(configuredOrigin(), "https://real.example:8443");
});

test("blank or unparseable APP_BASE_URL falls back rather than yielding a broken origin", () => {
  for (const raw of ["", "   ", "not a url"]) {
    process.env.APP_BASE_URL = raw;
    assert.equal(configuredOrigin(), null, `for ${JSON.stringify(raw)}`);
  }
});

test("with APP_BASE_URL unset the header-derived fallback is unchanged", () => {
  // Local dev and dynamic preview hostnames still work exactly as before —
  // this is why the fix is safe to land ahead of setting the var everywhere.
  delete process.env.APP_BASE_URL;
  assert.equal(
    originFromRequest(spoofed({ "x-forwarded-host": "preview-abc.vercel.app" })),
    "https://preview-abc.vercel.app",
  );
  assert.equal(originFromRequest(spoofed({ host: "localhost:3000" })), "http://localhost:3000");
  assert.equal(
    originFromRequest(spoofed({ host: "127.0.0.1:3000", "x-forwarded-proto": "https" })),
    "https://127.0.0.1:3000",
  );
});

test("with APP_BASE_URL unset, a spoofed header still wins — the documented residual risk", () => {
  // Recorded deliberately: this is exactly the state the fix asks deployments
  // to leave, and why APP_BASE_URL is documented as required in production.
  delete process.env.APP_BASE_URL;
  assert.equal(originFromRequest(spoofed({ "x-forwarded-host": "evil.example" })), "https://evil.example");
});

// --- the startup gate ------------------------------------------------------
// APP_BASE_URL is required exactly where the fronting proxy is untrusted. The
// two exemptions are load-bearing for the paths this project must not break:
// local development, and a fork pushed to Vercel (previews included).

function startupCase(opts: { prod?: boolean; vercel?: boolean; baseUrl?: string }) {
  // NODE_ENV is typed readonly; defineProperty is the supported way to set it
  // in-process, and this test needs both values.
  Object.defineProperty(process.env, "NODE_ENV", {
    value: opts.prod ? "production" : "development",
    configurable: true,
    writable: true,
    enumerable: true,
  });
  if (opts.vercel) process.env.VERCEL = "1";
  else delete process.env.VERCEL;
  if (opts.baseUrl) process.env.APP_BASE_URL = opts.baseUrl;
  else delete process.env.APP_BASE_URL;
  return baseUrlStartupError();
}

test("a container in production with no APP_BASE_URL refuses to start", () => {
  const err = startupCase({ prod: true });
  assert.ok(err, "expected a startup error");
  assert.match(err, /APP_BASE_URL/);
  // The message has to be actionable on its own — whoever hits this is reading
  // container logs, not this file.
  assert.match(err, /https:\/\/malloyyo\.example\.com/);
});

test("local development starts with nothing configured", () => {
  assert.equal(startupCase({}), null);
});

test("Vercel starts with nothing configured, production and preview alike", () => {
  // Vercel's edge overwrites X-Forwarded-*, so the header is trustworthy there;
  // and preview hostnames are per-deployment, so there is no value to demand.
  assert.equal(startupCase({ prod: true, vercel: true }), null);
});

test("a container in production WITH APP_BASE_URL starts", () => {
  assert.equal(startupCase({ prod: true, baseUrl: "https://real.example" }), null);
});

test("an unparseable APP_BASE_URL is treated as unset, not as satisfying the requirement", () => {
  // Otherwise a typo would pass the gate and silently fall back to the header.
  assert.ok(startupCase({ prod: true, baseUrl: "real.example" }));
});
