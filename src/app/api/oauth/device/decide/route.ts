// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Approve or deny a device flow (RFC 8628 §3.3). Cookie-authed: this is the step
// that binds a signed-in human's identity to a waiting CLI, so the session IS the
// authorization. Mirrors /api/oauth/authorize/decide.
//
// This is also the only place a short, human-typed code can be defended. A wrong
// guess cannot be attributed to any particular flow, so there is nothing to count
// on the row — the rate limit has to be on the caller.

import { getSessionUserOrNull } from "@/lib/user";
import { signInPath } from "@/lib/auth-paths";
import { originFromRequest } from "@/lib/oauth/base-url";
import { decideByUserCode, normalizeUserCode } from "@/lib/oauth/device-codes";
import { verifyDeviceApproval } from "@/lib/oauth/device-csrf";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Failed attempts per user, in this process. Best-effort by construction: on
    serverless each instance counts separately, so treat it as friction rather
    than a guarantee. It raises the cost of guessing ~34 bits well past useful
    without a shared store; if this ever needs to be a real limit, it belongs in
    Postgres next to the codes. */
const WINDOW_MS = 60_000;
const MAX_FAILURES = 8;
const failures = new Map<string, { count: number; resetAt: number }>();

function tooManyFailures(userId: string): boolean {
  const now = Date.now();
  const hit = failures.get(userId);
  if (!hit) return false;
  // Drop it rather than leaving it to accumulate: without this the map keeps one
  // entry per user who has ever failed, for the life of the process.
  if (hit.resetAt < now) {
    failures.delete(userId);
    return false;
  }
  return hit.count >= MAX_FAILURES;
}

function noteFailure(userId: string): void {
  const now = Date.now();
  const hit = failures.get(userId);
  if (!hit || hit.resetAt < now) {
    failures.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  hit.count += 1;
}

function back(request: Request, params: Record<string, string>): Response {
  const url = new URL("/oauth/device", originFromRequest(request));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUserOrNull();
  if (!user) {
    return Response.redirect(
      new URL(signInPath("/oauth/device"), originFromRequest(request)).toString(),
      302,
    );
  }

  const form = await request.formData();
  const rawCode = String(form.get("user_code") ?? "");
  const approve = String(form.get("action") ?? "") === "approve";

  // CSRF. The user_code is NOT a secret here — the attacker started the flow and
  // knows it — so without this the only thing standing between a cross-site POST
  // and a token scoped to this user is the cookie's SameSite=Lax default.
  // Enforcing that the blob was minted for THIS session also stops one lifted
  // from another session being replayed against a different victim.
  const approval = verifyDeviceApproval(String(form.get("t") ?? ""));
  if (!approval || approval.userId !== user.id) {
    logger.warn("device approval rejected: missing or mismatched CSRF token", { userId: user.id });
    return back(request, { error: "expired" });
  }

  if (!normalizeUserCode(rawCode)) return back(request, { error: "not_found" });

  // Denials are not guesses — let someone deny freely without burning their quota.
  if (approve && tooManyFailures(user.id)) {
    logger.warn("device code approval rate limited", { userId: user.id });
    return back(request, { error: "rate_limited" });
  }

  const result = await decideByUserCode(rawCode, user.id, approve);
  if (!result.ok) {
    if (approve) noteFailure(user.id);
    return back(request, { error: result.reason, user_code: rawCode });
  }

  logger.info("device code decided", { userId: user.id, approved: approve });
  return back(request, { ok: approve ? "approved" : "denied" });
}
