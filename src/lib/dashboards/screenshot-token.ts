// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The token a screenshot service carries to render ONE dashboard as ONE user.
//
// The app mints it (screenshot_dashboard, after checking the caller can see
// the dashboard) and hands it to the service, which sends it back on every
// request to this origin as the SCREENSHOT_TOKEN_HEADER. The service never
// learns what it names: it opens /screenshot and the app reads the token.
//
// What it grants is deliberately the same as that user opening that dashboard
// — the /screenshot page and the dashboard routes it calls (view, frame, run),
// for this dataset ref and dashboard name only (see viewer.ts). Every query is
// still the user's, under the same restricted-query gate.
//
// Signed with a key DERIVED from the dashboard secret, never the frame token's
// key itself: the sandboxed guest can read its own frame token, and a frame
// token must not verify here (it would turn "read your bundle" into "run
// queries as the viewer"). The `typ` claim says so twice.

import crypto from "node:crypto";
import { dashboardTokenSecret } from "./frame-token";

/** The request header the screenshot service sends the token in. */
export const SCREENSHOT_TOKEN_HEADER = "x-malloyyo-screenshot";

/** Long enough to load the page and run its queries, short enough not to matter if it leaks. */
const TTL_SECONDS = 90;

export interface ScreenshotClaims {
  userId: string;
  /** The dataset ref exactly as the page will pass it to the dashboard routes. */
  datasetId: string;
  name: string;
  /** Given values to open with, `$`-less names → filter text. */
  givens: Record<string, string>;
}

function key(): Buffer {
  return crypto.createHmac("sha256", dashboardTokenSecret()).update("malloyyo-screenshot-token-v1").digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", key()).update(payload).digest("base64url");
}

export function mintScreenshotToken(claims: ScreenshotClaims): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ typ: "screenshot", ...claims, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Signature, type and expiry; the claims, or null. The caller checks they name its route. */
export function verifyScreenshotToken(token: string): ScreenshotClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof c !== "object" || c === null || c.typ !== "screenshot") return null;
  if (typeof c.exp !== "number" || c.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof c.userId !== "string" || typeof c.datasetId !== "string" || typeof c.name !== "string") return null;
  const givens: Record<string, string> = {};
  if (c.givens && typeof c.givens === "object") {
    for (const [k, v] of Object.entries(c.givens as Record<string, unknown>)) {
      if (typeof v === "string") givens[k] = v;
    }
  }
  return { userId: c.userId, datasetId: c.datasetId, name: c.name, givens };
}
