// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The client for an optional screenshot service (screenshot/ in this repo):
// a headless browser, run apart from the app, that opens /screenshot with a
// token and returns a PNG. Configured by SCREENSHOT_SERVICE_URL and
// SCREENSHOT_SERVICE_KEY; with no URL there is no service, and
// screenshot_dashboard is never registered.
//
// The service is told nothing but the token. It renders this instance's own
// origin (its APP_ORIGIN) and nowhere else, so the app keeps every decision
// about who may see what.

export interface ScreenshotServiceConfig {
  url: string;
  key: string;
}

export function screenshotServiceConfig(): ScreenshotServiceConfig | null {
  const url = process.env.SCREENSHOT_SERVICE_URL?.trim();
  if (!url) return null;
  return { url: url.replace(/\/$/, ""), key: process.env.SCREENSHOT_SERVICE_KEY ?? "" };
}

/** What the page did while it rendered: enough to tell a real picture from a broken one. */
export interface ScreenshotDiagnostics {
  /** True when the page was still busy at the service's deadline — the picture may be partial. */
  timedOut: boolean;
  /** Errors the dashboard drew in place of a tile (the renderer shows them; it doesn't log them). */
  renderErrors: string[];
  consoleErrors: string[];
  pageErrors: string[];
  /** Requests the page made that failed, and requests to other origins the service refused. */
  failedRequests: string[];
  blockedRequests: string[];
  durationMs: number;
}

export type ScreenshotResult =
  | { ok: true; png: string; width: number; height: number; diagnostics: ScreenshotDiagnostics }
  | { ok: false; error: string };

/** Longer than the service's own render deadline, so its answer (even "timed out") arrives. */
const REQUEST_TIMEOUT_MS = 60_000;

export async function requestScreenshot(cfg: ScreenshotServiceConfig, token: string): Promise<ScreenshotResult> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `screenshot service unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `screenshot service answered ${res.status} with no JSON` };
  }
  if (!res.ok || body.ok !== true || typeof body.png !== "string") {
    return { ok: false, error: `screenshot service: ${typeof body.error === "string" ? body.error : `status ${res.status}`}` };
  }
  return {
    ok: true,
    png: body.png,
    width: Number(body.width),
    height: Number(body.height),
    diagnostics: body.diagnostics as ScreenshotDiagnostics,
  };
}
