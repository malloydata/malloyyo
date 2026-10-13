// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Who is viewing a dashboard: the session, or a screenshot token that names
// exactly this dashboard. Used by the page and the routes a dashboard calls
// (view, frame, run) — and nothing else, so the token opens nothing else.
//
// A request that carries the screenshot header is judged by the token ALONE:
// an invalid or mismatched one is refused rather than falling back to a
// session, so a header that doesn't fit never quietly means something else.

import { headers } from "next/headers";
import type { User } from "@/db";
import { getAuthorizedUser, getSessionUser, UnauthorizedError } from "@/lib/user";
import { SCREENSHOT_TOKEN_HEADER, verifyScreenshotToken, type ScreenshotClaims } from "./screenshot-token";

/** The screenshot token on this request, verified; null when there is none. Throws on a bad one. */
export async function screenshotClaims(): Promise<ScreenshotClaims | null> {
  const raw = (await headers()).get(SCREENSHOT_TOKEN_HEADER);
  if (raw === null) return null;
  const claims = verifyScreenshotToken(raw);
  if (!claims) throw new UnauthorizedError("invalid or expired screenshot token");
  return claims;
}

export async function getDashboardViewer(datasetId: string, name: string): Promise<User> {
  const claims = await screenshotClaims();
  if (!claims) return getSessionUser();
  if (claims.datasetId !== datasetId || claims.name !== name) {
    throw new UnauthorizedError("screenshot token is for a different dashboard");
  }
  return getAuthorizedUser(claims.userId);
}

/** Whether this request came from a screenshot service (its token already checked by getDashboardViewer). */
export async function isScreenshotRequest(): Promise<boolean> {
  return (await headers()).has(SCREENSHOT_TOKEN_HEADER);
}
