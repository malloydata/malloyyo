// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where this instance runs, and so how a secret gets into its environment.
//
// Every credential a model uses is an environment variable: malloy-config.json
// names it as `{"env": NAME}` and Malloy resolves it from process.env. There is
// no store of our own, deliberately — so setting one is the PLATFORM's job:
//
//   cloud        Malloyyo Cloud. The hosted build contributes a Secrets admin
//                page (`/admin/x/secrets`) whose handler forwards to the control
//                plane, which writes Fly secrets and rolls the instance. We call
//                that handler in-process with the admin's own request, so its
//                authorization (the Stytch session, the tenant binding) is the
//                one that applies. Detected by the page existing, not by env.
//   vercel       The operator adds the variable in the project's settings and
//                redeploys.
//   self-hosted  Docker or any other host: `-e NAME=…` or an env file, then a
//                restart.
//
// Values are never read back from anywhere: presence is all this reports.

import { randomUUID } from "node:crypto";
import { hostedIntegration } from "./hosted-auth-integration";

export type Platform = "cloud" | "vercel" | "self-hosted";

/** The hosted Secrets page, when this build has one. */
function hostedSecretsPage() {
  return hostedIntegration()?.adminPages?.find((p) => p.slug === "secrets" && p.handleAction) ?? null;
}

export function instancePlatform(): Platform {
  if (hostedSecretsPage()) return "cloud";
  if (process.env.VERCEL) return "vercel";
  return "self-hosted";
}

/** Which of `names` are set in this process's environment — never their values. */
export function envPresence(names: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((n) => [n, Boolean(process.env[n]?.length)]));
}

/** Names the platform owns: never set through setup, whatever the platform. */
const OWNED = new Set(["DATABASE_URL", "AUTH_SECRET", "GITHUB_TOKEN_FALLBACK", "APP_BASE_URL"]);
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

export function settableName(name: string): boolean {
  return ENV_NAME_RE.test(name) && !OWNED.has(name) && !name.startsWith("MALLOYYO_") && !name.startsWith("STYTCH_");
}

export type HostedResult =
  | { ok: true; operation: { id: string; status: string } | null }
  | { ok: false; status: number; error: string };

async function hostedCall(request: Request, init: { method: string; search?: string; body?: unknown }): Promise<HostedResult> {
  const page = hostedSecretsPage();
  if (!page?.handleAction) return { ok: false, status: 404, error: "this instance has no Secrets page (not Malloyyo Cloud)" };
  const url = new URL(`/api/admin/x/secrets${init.search ?? ""}`, request.url);
  const headers = new Headers({ cookie: request.headers.get("cookie") ?? "" });
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", randomUUID());
  }
  const res = await page.handleAction(
    new Request(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
  const out = (await res.json().catch(() => null)) as {
    operation?: { id: string; status: string };
    error?: string;
    message?: string;
  } | null;
  if (!res.ok) {
    return { ok: false, status: res.status, error: out?.message ?? out?.error ?? `secrets request failed (${res.status})` };
  }
  return { ok: true, operation: out?.operation ?? null };
}

/**
 * Set environment variables on a Malloyyo Cloud instance, through its own
 * Secrets page. The instance restarts to pick them up (about a minute); the
 * returned operation is what to poll. Only names `settableName` allows.
 */
export async function setHostedSecrets(request: Request, values: Record<string, string>): Promise<HostedResult> {
  const bad = Object.keys(values).filter((n) => !settableName(n));
  if (bad.length) return { ok: false, status: 400, error: `not settable here: ${bad.join(", ")}` };
  return hostedCall(request, { method: "POST", body: { secrets: values } });
}

/** A Cloud secrets operation's status (`running`, `succeeded`, `failed`, …). */
export async function hostedOperation(request: Request, id: string): Promise<HostedResult> {
  if (!/^op_[0-9a-f]{32}$/.test(id)) return { ok: false, status: 400, error: "not an operation id" };
  return hostedCall(request, { method: "GET", search: `?operation=${id}` });
}

/** What to tell an operator who must set variables themselves. */
export function manualInstructions(platform: Platform, names: readonly string[]): string {
  const list = names.join(", ");
  return platform === "vercel"
    ? `In the Vercel project: Settings → Environment Variables, add ${list} (Production, and Preview if you use it), then redeploy.`
    : `Add ${list} to the instance's environment — \`-e NAME=value\` on \`docker run\`, or lines in its env file — then restart it.`;
}
