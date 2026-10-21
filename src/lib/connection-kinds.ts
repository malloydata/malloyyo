// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The database connections guided setup knows how to configure, as DATA: their
// fields, which fields are secrets, the environment variable each secret lives
// in, and the malloy-config.json entry they produce. Pure — no Malloy, no
// database — so the setup page (client), the API routes and the MCP tools all
// build the same config from the same rules, and it is testable on its own.
//
// SECRETS NEVER GO IN THE CONFIG. A secret field becomes an `{"env": NAME}`
// reference, NAME derived from the connection's name (`warehouse` →
// `WAREHOUSE_PASSWORD`), and the value lives in the instance's environment —
// set through Malloyyo Cloud's Secrets page, or by the operator on Vercel or
// Docker (src/lib/instance-platform.ts). Everything else is literal config.

export const CONNECTION_KINDS = ["motherduck", "bigquery", "postgres"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export type ConnectionField = {
  /** The form field and the key in `settings`. */
  key: string;
  label: string;
  /** Stored in the environment and referenced from the config, never written into it. */
  secret: boolean;
  required: boolean;
  /** For a secret: the env var suffix (`<CONNECTION>_<suffix>`). */
  envSuffix?: string;
  placeholder?: string;
  help?: string;
  /** A large value (a service-account key) gets a textarea. */
  multiline?: boolean;
  kind?: "text" | "number" | "boolean";
  defaultValue?: string;
};

export type ConnectionKindSpec = {
  label: string;
  /** What to ask for, in one line, on the page and in Claude's instructions. */
  needs: string;
  fields: ConnectionField[];
};

export const KIND_SPECS: Record<ConnectionKind, ConnectionKindSpec> = {
  motherduck: {
    label: "MotherDuck",
    needs: "a MotherDuck access token (motherduck.com → Settings → Access Tokens), and optionally a database name",
    fields: [
      { key: "token", label: "Access token", secret: true, required: true, envSuffix: "TOKEN" },
      {
        key: "database",
        label: "Database",
        secret: false,
        required: false,
        placeholder: "my_db",
        help: "Leave empty to see every database the token can reach.",
      },
    ],
  },
  bigquery: {
    label: "BigQuery",
    needs: "a Google Cloud project id and a service-account key (JSON) with BigQuery Data Viewer and Job User",
    fields: [
      { key: "projectId", label: "Project id", secret: false, required: true, placeholder: "my-project" },
      {
        key: "serviceAccountKey",
        label: "Service account key (JSON)",
        secret: true,
        required: true,
        envSuffix: "SERVICE_ACCOUNT_KEY",
        multiline: true,
        help: "The whole key file. Grant it BigQuery Data Viewer and BigQuery Job User.",
      },
      { key: "location", label: "Location", secret: false, required: false, placeholder: "US" },
    ],
  },
  postgres: {
    label: "Postgres",
    needs: "the host, port, database name, a read-only user and its password",
    fields: [
      { key: "host", label: "Host", secret: false, required: true, placeholder: "db.example.com" },
      { key: "port", label: "Port", secret: false, required: false, kind: "number", defaultValue: "5432" },
      { key: "databaseName", label: "Database", secret: false, required: true },
      { key: "username", label: "User", secret: false, required: true, help: "A read-only user is best." },
      { key: "password", label: "Password", secret: true, required: true, envSuffix: "PASSWORD" },
      {
        key: "ssl",
        label: "Require SSL",
        secret: false,
        required: false,
        kind: "boolean",
        defaultValue: "true",
        help: "Hosted Postgres (Neon, RDS, Supabase…) needs it.",
      },
    ],
  },
};

export function isConnectionKind(s: unknown): s is ConnectionKind {
  return typeof s === "string" && (CONNECTION_KINDS as readonly string[]).includes(s);
}

/** A connection name a config can use and an env var prefix can be made from. */
export const CONNECTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The env var a connection's secret field lives in: `warehouse` + `PASSWORD` → `WAREHOUSE_PASSWORD`. */
export function envNameFor(connection: string, field: ConnectionField): string {
  return `${connection.toUpperCase()}_${field.envSuffix ?? field.key.toUpperCase()}`;
}

/** Every env var a connection needs, in field order. */
export function envNamesFor(kind: ConnectionKind, connection: string): string[] {
  return KIND_SPECS[kind].fields.filter((f) => f.secret).map((f) => envNameFor(connection, f));
}

type Fail = { ok: false; error: string };

/**
 * Check a connection's name and its NON-secret settings. Secret values are
 * checked separately, by whoever has them (the save route); nothing here
 * should ever be handed one.
 */
export function validateConnection(
  kind: unknown,
  name: unknown,
  settings: Record<string, unknown> = {},
): { ok: true; kind: ConnectionKind; name: string; settings: Record<string, string> } | Fail {
  if (!isConnectionKind(kind)) return { ok: false, error: `kind must be one of ${CONNECTION_KINDS.join(", ")}` };
  if (typeof name !== "string" || !CONNECTION_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "connection name must be lowercase letters, digits and underscores, starting with a letter (e.g. warehouse)",
    };
  }
  const out: Record<string, string> = {};
  for (const f of KIND_SPECS[kind].fields) {
    if (f.secret) continue;
    const raw = settings[f.key];
    const v = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!v && f.required) return { ok: false, error: `${KIND_SPECS[kind].label} needs ${f.label.toLowerCase()}` };
    if (v && f.kind === "number" && !/^\d+$/.test(v)) return { ok: false, error: `${f.label} must be a number` };
    if (v) out[f.key] = v;
  }
  return { ok: true, kind, name, settings: out };
}

/**
 * The malloy-config.json entry for a connection. Secrets are `{"env": NAME}`
 * references unless `secrets` supplies literal values — which only the save
 * route does, to TEST a credential before it is stored; that entry must never
 * be written anywhere.
 */
export function connectionEntry(
  kind: ConnectionKind,
  name: string,
  settings: Record<string, string>,
  secrets?: Record<string, string>,
): Record<string, unknown> {
  const spec = KIND_SPECS[kind];
  const secret = (key: string) => {
    const f = spec.fields.find((x) => x.key === key)!;
    return secrets ? secrets[key] : { env: envNameFor(name, f) };
  };
  switch (kind) {
    case "motherduck":
      return {
        is: "duckdb",
        databasePath: settings.database ? `md:${settings.database}` : "md:",
        motherDuckToken: secret("token"),
      };
    case "bigquery":
      return {
        is: "bigquery",
        projectId: settings.projectId,
        ...(settings.location ? { location: settings.location } : {}),
        serviceAccountKeyJson: secret("serviceAccountKey"),
      };
    case "postgres":
      return {
        is: "postgres",
        host: settings.host,
        port: Number(settings.port || "5432"),
        databaseName: settings.databaseName,
        username: settings.username,
        password: secret("password"),
        ...(settings.ssl === "false" ? {} : { ssl: true }),
      };
  }
}

/** A whole malloy-config.json holding one connection, as text. */
export function configJsonFor(name: string, entry: Record<string, unknown>): string {
  return JSON.stringify({ connections: { [name]: entry } }, null, 2);
}
