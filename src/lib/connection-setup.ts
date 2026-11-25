// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Testing a database connection during setup — before any repo, model or
// publish exists. API routes and MCP tools only: it reaches @/lib/malloy.
//
// Two modes, by where the secret is:
//   - from the environment (`secrets` omitted): the connection as a model will
//     open it, `{"env": …}` references resolved from process.env. What Vercel
//     and Docker test after the operator has set the variables.
//   - literal (`secrets` given): Malloyyo Cloud tests a credential BEFORE saving
//     it, because saving restarts the instance and nothing can read a value
//     back. The values live only in this call: never logged, never stored, and
//     the config built from them is never returned.

import {
  configJsonFor,
  connectionEntry,
  envNamesFor,
  KIND_SPECS,
  validateConnection,
  type ConnectionKind,
} from "./connection-kinds";
import { envPresence } from "./instance-platform";
import { withConfigConnection } from "./malloy";

const TEST_TIMEOUT_MS = 25_000;

export type ConnectionTest =
  | {
      ok: true;
      kind: ConnectionKind;
      name: string;
      dialect: string;
      /** The malloy-config.json to write: secrets as `{"env": …}` references. */
      config: string;
      env: Record<string, boolean>;
      ms: number;
    }
  | { ok: false; error: string; env?: Record<string, boolean>; config?: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s — check the host, network access and firewall`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Strip anything that looks like a secret out of a driver's error text. */
function scrub(message: string, secrets: Record<string, string> | undefined): string {
  let m = message;
  for (const v of Object.values(secrets ?? {})) if (v && v.length >= 4) m = m.split(v).join("•••");
  return m.length > 600 ? `${m.slice(0, 600)}…` : m;
}

export async function testConnection(
  kindRaw: unknown,
  nameRaw: unknown,
  settingsRaw: Record<string, unknown> | undefined,
  secrets?: Record<string, string>,
): Promise<ConnectionTest> {
  const v = validateConnection(kindRaw, nameRaw, settingsRaw ?? {});
  if (!v.ok) return v;
  const { kind, name, settings } = v;
  const config = configJsonFor(name, connectionEntry(kind, name, settings));
  const env = envPresence(envNamesFor(kind, name));

  if (secrets) {
    const missing = KIND_SPECS[kind].fields.filter((f) => f.secret && f.required && !secrets[f.key]?.trim());
    if (missing.length) return { ok: false, error: `missing ${missing.map((f) => f.label.toLowerCase()).join(", ")}` };
  } else {
    const unset = Object.entries(env).filter(([, set]) => !set).map(([n]) => n);
    if (unset.length) {
      return {
        ok: false,
        error: `not set in this instance's environment yet: ${unset.join(", ")}`,
        env,
        config,
      };
    }
  }

  const live = secrets ? configJsonFor(name, connectionEntry(kind, name, settings, secrets)) : config;
  const started = Date.now();
  try {
    const dialect = await withTimeout(
      withConfigConnection(live, name, async (conn) => {
        await conn.runSQL("SELECT 1 AS ok", { rowLimit: 1 });
        return conn.dialectName;
      }),
      TEST_TIMEOUT_MS,
    );
    return { ok: true, kind, name, dialect, config, env, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: scrub(err instanceof Error ? err.message : String(err), secrets), env, config };
  }
}
