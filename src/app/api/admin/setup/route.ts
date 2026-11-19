// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `/api/admin/setup` — the guided setup page's server half. Admins only.
 *
 *   GET                    setup status (src/lib/setup-status.ts)
 *   GET ?operation=op_…    a Malloyyo Cloud secrets operation's status
 *   POST {action, …}       one of:
 *     test-connection  {kind, name, settings, secrets?}
 *     save-connection  {kind, name, settings, secrets}   Cloud: test, then save
 *     test-github      {repo, token?}
 *     save-github      {repo, token}                     Cloud: test, then save
 *     webhook-secret   {save?: boolean}                  new secret; Cloud saves it
 *     authoring        {}                                Cloud: REPO_AUTHORING=1
 *
 * SECRET VALUES arrive here only to be tested and, on Cloud, handed to the
 * hosted Secrets page in the same request (src/lib/instance-platform.ts). They
 * are never logged, stored, or sent back — except a webhook secret this route
 * just generated, which the person has to paste into GitHub once.
 *
 * JSON bodies only: a cross-site form can't send one, so a session cookie
 * alone can't be ridden into saving secrets.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { envNameFor, isConnectionKind, KIND_SPECS } from "@/lib/connection-kinds";
import { testConnection } from "@/lib/connection-setup";
import { newWebhookSecret, testGitHubToken } from "@/lib/github-setup";
import { hostedOperation, instancePlatform, savesSecrets, setHostedSecrets } from "@/lib/instance-platform";
import { logger } from "@/lib/logger";
import { setupStatus } from "@/lib/setup-status";
import { UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

async function admin(): Promise<Response | null> {
  try {
    await requireAdmin();
    return null;
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ ok: false, error: err.message }, 403);
    throw err;
  }
}

export async function GET(req: Request) {
  const denied = await admin();
  if (denied) return denied;
  const op = new URL(req.url).searchParams.get("operation");
  if (op) {
    const r = await hostedOperation(req, op);
    return r.ok ? json({ ok: true, operation: r.operation }) : json({ ok: false, error: r.error }, r.status);
  }
  return json({ ok: true, status: await setupStatus() });
}

type Body = {
  action?: string;
  kind?: unknown;
  name?: unknown;
  settings?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  repo?: unknown;
  token?: unknown;
  save?: unknown;
};

/** Only the secret fields a kind declares, as strings: nothing else is taken from `secrets`. */
function secretValues(kind: unknown, raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!raw || !isConnectionKind(kind)) return undefined;
  const spec = KIND_SPECS[kind];
  const out: Record<string, string> = {};
  for (const f of spec.fields) if (f.secret && typeof raw[f.key] === "string") out[f.key] = (raw[f.key] as string).trim();
  return out;
}

export async function POST(req: Request) {
  const denied = await admin();
  if (denied) return denied;
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ ok: false, error: "send JSON" }, 415);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.action) return json({ ok: false, error: "no action" }, 400);
  // Cloud saves through its Secrets page; a local dev server into its env file.
  const cloud = savesSecrets(instancePlatform());

  switch (body.action) {
    case "test-connection": {
      const r = await testConnection(body.kind, body.name, body.settings, secretValues(body.kind, body.secrets));
      return json(r);
    }

    case "save-connection": {
      if (!cloud) return json({ ok: false, error: "only Malloyyo Cloud saves secrets from here; set them in your platform" }, 400);
      const secrets = secretValues(body.kind, body.secrets);
      if (!secrets) return json({ ok: false, error: "no secret values" }, 400);
      // Test BEFORE saving: a save restarts the instance, and a wrong password
      // would cost a restart to find out.
      const tested = await testConnection(body.kind, body.name, body.settings, secrets);
      if (!tested.ok) return json(tested);
      const spec = KIND_SPECS[tested.kind];
      const values: Record<string, string> = {};
      for (const f of spec.fields) if (f.secret && secrets[f.key]) values[envNameFor(tested.name, f)] = secrets[f.key];
      const saved = await setHostedSecrets(req, values);
      logger.info("setup: connection secrets saved", { connection: tested.name, kind: tested.kind, names: Object.keys(values) });
      return saved.ok
        ? json({ ...tested, operation: saved.operation })
        : json({ ok: false, error: saved.error, config: tested.config }, saved.status);
    }

    case "test-github": {
      if (typeof body.repo !== "string") return json({ ok: false, error: "give the repo (owner/name)" }, 400);
      return json(await testGitHubToken(body.repo, typeof body.token === "string" ? body.token : undefined));
    }

    case "save-github": {
      if (!cloud) return json({ ok: false, error: "only Malloyyo Cloud saves secrets from here; set GITHUB_TOKEN in your platform" }, 400);
      if (typeof body.repo !== "string" || typeof body.token !== "string" || !body.token.trim()) {
        return json({ ok: false, error: "give the repo and the token" }, 400);
      }
      const tested = await testGitHubToken(body.repo, body.token);
      if (!tested.ok) return json(tested);
      const saved = await setHostedSecrets(req, { GITHUB_TOKEN: body.token.trim() });
      logger.info("setup: GITHUB_TOKEN saved", { repo: tested.repo });
      return saved.ok ? json({ ...tested, operation: saved.operation }) : json({ ok: false, error: saved.error }, saved.status);
    }

    case "webhook-secret": {
      const secret = newWebhookSecret();
      if (cloud && body.save === true) {
        const saved = await setHostedSecrets(req, { GITHUB_WEBHOOK_SECRET: secret });
        logger.info("setup: GITHUB_WEBHOOK_SECRET saved");
        return saved.ok ? json({ ok: true, secret, operation: saved.operation }) : json({ ok: false, error: saved.error }, saved.status);
      }
      return json({ ok: true, secret });
    }

    case "authoring": {
      if (!cloud) return json({ ok: false, error: "set REPO_AUTHORING=1 in your platform's environment" }, 400);
      const saved = await setHostedSecrets(req, { REPO_AUTHORING: "1" });
      logger.info("setup: REPO_AUTHORING turned on");
      return saved.ok ? json({ ok: true, operation: saved.operation }) : json({ ok: false, error: saved.error }, saved.status);
    }

    default:
      return json({ ok: false, error: `unknown action ${body.action}` }, 400);
  }
}
