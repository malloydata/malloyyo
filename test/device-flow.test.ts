// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Integration test for the device authorization grant (RFC 8628) against a real
// Postgres. These behaviours cannot be checked any other way: every one of them
// is a property of a row transition, and the interesting ones — consume-once,
// slow_down, the client binding — are exactly where a typecheck tells you
// nothing.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres and
// points DATABASE_URL at it).

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, users, oauthClients, oauthDeviceCodes, type User } from "@/db";
import { GET as authorizeRoute } from "@/app/api/oauth/authorize/route";
import { POST as tokenRoute } from "@/app/api/oauth/token/route";
import { POST as deviceAuthorizationRoute } from "@/app/api/oauth/device_authorization/route";
import {
  DEVICE_GRANT_TYPE,
  DEVICE_POLL_INTERVAL_SEC,
  decideByUserCode,
  findPendingByUserCode,
  hashCode,
  issueDeviceCode,
  normalizeUserCode,
  pollDeviceCode,
} from "@/lib/oauth/device-codes";

let user: User;
let clientId: string;

before(async () => {
  // Unique per run: the hosted harness gives each file a fresh schema, but a test
  // that cannot be re-run against a warm database is needlessly annoying to debug.
  const [u] = await db
    .insert(users)
    .values({ email: `device-${randomUUID()}@test.local` })
    .returning();
  user = u;
  const [c] = await db
    .insert(oauthClients)
    .values({
      name: "malloyyo CLI",
      redirectUris: ["http://localhost/unused-by-device-flow"],
      tokenEndpointAuthMethod: "none",
      grantTypes: [DEVICE_GRANT_TYPE, "refresh_token"],
      responseTypes: ["code"],
      scope: "mcp",
    })
    .returning();
  clientId = c.id;
});

const issue = () => issueDeviceCode({ clientId, scope: "mcp", resource: null });

test("the user code is shaped for a human to read off one screen and type into another", async () => {
  const { userCode } = await issue();
  assert.match(userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  // No vowels means it can never produce a word; no 0/O/1/I means it can't be
  // mistyped into a different valid code.
  assert.ok(!/[AEIOU01]/.test(userCode), `${userCode} contains an ambiguous character`);
});

test("a user code is found however the human types it", async () => {
  const { userCode } = await issue();
  for (const variant of [userCode, userCode.toLowerCase(), userCode.replace("-", ""), ` ${userCode} `]) {
    const row = await findPendingByUserCode(variant);
    assert.ok(row, `expected ${JSON.stringify(variant)} to resolve`);
  }
});

test("neither code is stored in the clear", async () => {
  const { deviceCode, userCode } = await issue();
  const rows = await db.select().from(oauthDeviceCodes);
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes(deviceCode), "device_code was stored in the clear");
  assert.ok(!raw.includes(normalizeUserCode(userCode)), "user_code was stored in the clear");
});

test("polling before approval is pending, not an error", async () => {
  const { deviceCode } = await issue();
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "pending");
});

test("approval binds the user, and the next poll issues exactly once", async () => {
  const { deviceCode, userCode } = await issue();
  assert.deepEqual(await decideByUserCode(userCode, user.id, true), { ok: true });

  const first = await pollDeviceCode(deviceCode, clientId);
  assert.equal(first.status, "approved");
  if (first.status === "approved") {
    assert.equal(first.row.userId, user.id, "the approving user must be bound to the grant");
    assert.equal(first.row.scope, "mcp");
  }

  // Consume-once. A replayed device_code must not mint a second token pair.
  const second = await pollDeviceCode(deviceCode, clientId);
  assert.equal(second.status, "not_found", "a consumed device_code was accepted twice");
});

test("two simultaneous polls cannot both be approved", async () => {
  const { deviceCode, userCode } = await issue();
  await decideByUserCode(userCode, user.id, true);
  // The conditional UPDATE is the lock; race it to prove that.
  const results = await Promise.all([
    pollDeviceCode(deviceCode, clientId),
    pollDeviceCode(deviceCode, clientId),
  ]);
  const approved = results.filter((r) => r.status === "approved");
  assert.equal(approved.length, 1, `expected exactly one approval, got ${results.map((r) => r.status).join("+")}`);
});

test("polling faster than the advertised interval earns slow_down", async () => {
  const { deviceCode } = await issue();
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "pending");
  // Immediately again: well inside the interval the server advertised.
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "slow_down");
  assert.ok(DEVICE_POLL_INTERVAL_SEC >= 5, "the advertised interval should not be aggressive");
});

test("a denial is reported as denial, not as pending", async () => {
  const { deviceCode, userCode } = await issue();
  await decideByUserCode(userCode, user.id, false);
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "denied");
});

test("two simultaneous decisions bind exactly one user", async () => {
  // The person who typed the code, and someone handed the verification_uri_complete
  // link, both submit within the same few milliseconds. A read-then-write would
  // let both through and the second writer would re-bind the grant to themselves;
  // the conditional UPDATE is what makes the first decision final.
  const [other] = await db
    .insert(users)
    .values({ email: `device-other-${randomUUID()}@test.local` })
    .returning();
  const { deviceCode, userCode } = await issue();
  const results = await Promise.all([
    decideByUserCode(userCode, user.id, true),
    decideByUserCode(userCode, other.id, true),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, `expected exactly one ok, got ${JSON.stringify(results)}`);
  const winner = results[0].ok ? user.id : other.id;
  const polled = await pollDeviceCode(deviceCode, clientId);
  assert.equal(polled.status, "approved");
  if (polled.status === "approved") {
    assert.equal(polled.row.userId, winner, "the grant is bound to the decision that won, not the last writer");
  }
});

test("a decided code cannot be decided again", async () => {
  const { userCode } = await issue();
  await decideByUserCode(userCode, user.id, true);
  // Approving twice would let a second person re-bind a live grant to themselves.
  assert.deepEqual(await decideByUserCode(userCode, user.id, true), { ok: false, reason: "not_found" });
});

test("an expired code is expired, and is never approvable", async () => {
  const { deviceCode, userCode } = await issue();
  await db
    .update(oauthDeviceCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(oauthDeviceCodes.clientId, clientId));
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "expired");
  assert.deepEqual(await decideByUserCode(userCode, user.id, true), { ok: false, reason: "not_found" });
  // Put it back so later tests are unaffected by the clock surgery above.
  await db
    .update(oauthDeviceCodes)
    .set({ expiresAt: new Date(Date.now() + 600_000) })
    .where(eq(oauthDeviceCodes.clientId, clientId));
});

test("a device_code is bound to the client that requested it", async () => {
  const { deviceCode, userCode } = await issue();
  await decideByUserCode(userCode, user.id, true);
  const [other] = await db
    .insert(oauthClients)
    .values({
      name: "someone else",
      redirectUris: ["http://localhost/x"],
      tokenEndpointAuthMethod: "none",
      grantTypes: [DEVICE_GRANT_TYPE],
      responseTypes: ["code"],
      scope: "mcp",
    })
    .returning();
  // Another registered client must not be able to redeem this grant.
  assert.equal((await pollDeviceCode(deviceCode, other.id)).status, "not_found");
  // And the rightful client still can — the rejection above consumed nothing.
  assert.equal((await pollDeviceCode(deviceCode, clientId)).status, "approved");
});

test("an unknown device_code is rejected", async () => {
  assert.equal((await pollDeviceCode("not-a-real-device-code", clientId)).status, "not_found");
});

// ── registered grants are enforced ─────────────────────────────────────────
//
// A device-flow client registers with a placeholder redirect_uri (registration
// requires one). That placeholder is safe ONLY because the server refuses the
// authorization-code flow to a client that never registered for it — at
// /authorize, before anything is sent to the redirect, and at the token
// endpoint. These pin that, and the mirror image for a loopback client that
// tries the device grant.

async function loopbackClient(): Promise<string> {
  const [c] = await db
    .insert(oauthClients)
    .values({
      name: "loopback CLI",
      redirectUris: ["http://localhost:41121/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scope: "mcp",
    })
    .returning();
  return c.id;
}

function form(fields: Record<string, string>): Request {
  return new Request("http://test.local/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

test("a device-only client's placeholder redirect cannot start an authorization-code flow", async () => {
  const url = new URL("http://test.local/api/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://localhost/unused-by-device-flow",
    response_type: "code",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const res = await authorizeRoute(new Request(url));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /unauthorized_client/);
});

test("a device-only client cannot redeem an authorization code", async () => {
  const res = await tokenRoute(
    form({
      grant_type: "authorization_code",
      code: "whatever",
      redirect_uri: "http://localhost/unused-by-device-flow",
      client_id: clientId,
      code_verifier: "v".repeat(43),
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "unauthorized_client");
});

test("a loopback client cannot start or redeem a device flow", async () => {
  const loopback = await loopbackClient();
  const start = await deviceAuthorizationRoute(
    new Request("http://test.local/api/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: loopback, scope: "mcp" }).toString(),
    }),
  );
  assert.equal(start.status, 400);
  assert.equal(((await start.json()) as { error: string }).error, "unauthorized_client");

  const redeem = await tokenRoute(form({ grant_type: DEVICE_GRANT_TYPE, device_code: "whatever", client_id: loopback }));
  assert.equal(redeem.status, 400);
  assert.equal(((await redeem.json()) as { error: string }).error, "unauthorized_client");
});

test("the token endpoint speaks the device grant end to end for a registered client", async () => {
  // The positive case, through the real handler: pending, then a token pair.
  const { deviceCode, userCode } = await issue();
  const poll = () => tokenRoute(form({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: clientId }));
  const first = await poll();
  assert.equal(first.status, 400);
  assert.equal(((await first.json()) as { error: string }).error, "authorization_pending");

  await decideByUserCode(userCode, user.id, true);
  // Inside the interval: slow_down, and the approval is NOT consumed by it.
  const early = await poll();
  assert.equal(((await early.json()) as { error: string }).error, "slow_down");
  // Wind the interval clock back rather than sleeping five seconds.
  await db
    .update(oauthDeviceCodes)
    .set({ lastPolledAt: null })
    .where(eq(oauthDeviceCodes.deviceCodeHash, hashCode(deviceCode)));
  const granted = await poll();
  assert.equal(granted.status, 200, await granted.clone().text());
  const body = (await granted.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
  assert.ok(body.access_token && body.refresh_token, "a token pair");
  assert.equal(body.token_type, "Bearer");
});
