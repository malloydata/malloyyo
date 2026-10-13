// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The screenshot token opens one dashboard as one user. These pin that it
// can't be forged, outlived, or swapped with the frame token — which the
// sandboxed dashboard code can read, and which must never verify here.

process.env.DASHBOARD_TOKEN_SECRET = "test-dashboard-secret";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mintScreenshotToken, verifyScreenshotToken } from "./screenshot-token";
import { mintFrameToken, verifyFrameToken } from "./frame-token";

const claims = {
  userId: "u-1",
  datasetId: "acme:sales",
  name: "overview",
  givens: { CATEGORY: "Jeans" },
};

test("a minted token verifies to its claims", () => {
  assert.deepEqual(verifyScreenshotToken(mintScreenshotToken(claims)), claims);
});

test("any change to payload or signature is refused", () => {
  const token = mintScreenshotToken(claims);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), name: "secret_dash" }),
  ).toString("base64url");
  assert.equal(verifyScreenshotToken(`${forged}.${sig}`), null);
  const flipped = sig!.slice(0, -1) + (sig!.endsWith("A") ? "B" : "A");
  assert.equal(verifyScreenshotToken(`${payload}.${flipped}`), null);
  assert.equal(verifyScreenshotToken("not-a-token"), null);
});

test("an expired token is refused", (t) => {
  const token = mintScreenshotToken(claims);
  const later = Date.now() + 10 * 60 * 1000;
  t.mock.method(Date, "now", () => later);
  assert.equal(verifyScreenshotToken(token), null);
});

test("a frame token is not a screenshot token, and the reverse", () => {
  const frame = mintFrameToken({ userId: "u-1", datasetId: "acme:sales", name: "overview" });
  assert.equal(verifyScreenshotToken(frame), null);
  assert.equal(verifyFrameToken(mintScreenshotToken(claims)), null);
});

test("givens keep only string values", () => {
  const token = mintScreenshotToken({ ...claims, givens: { A: "x", B: 3 as unknown as string } });
  assert.deepEqual(verifyScreenshotToken(token)?.givens, { A: "x" });
});
