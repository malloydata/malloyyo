// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * DuckDB CAN'T READ THIS SERVER'S LOCAL FILES.
 *
 * DuckDB runs in this process, so a model's SQL could read anything the
 * process can: `read_text('/proc/self/environ')` is the server's whole
 * environment (DATABASE_URL, AUTH_SECRET, …), `~/.aws` its cloud credentials.
 * Every DuckDB connection the server opens — a repo's own `duckdb` entries
 * and the server's fallback — gets the same recipe, applied in this order:
 *
 *   1. Malloy's baseline loads the extensions (httpfs, MotherDuck for `md:`,
 *      any `additionalExtensions`) while external access is still on.
 *   2. OUR restriction: `allowed_directories` = this connection's private
 *      scratch directory plus the remote schemes, then
 *      `enable_external_access=false`.
 *   3. The repo's own `setupSQL`, unchanged — now running INSIDE the sandbox.
 *      DuckDB itself refuses to loosen anything once external access is off
 *      (re-enabling it, widening allowed_directories or allowed_paths), even
 *      before the lock, so no scanning of it is needed.
 *   4. `lock_configuration=true` (Malloy's `lockConfiguration`).
 *
 * The NETWORK is deliberately not restricted: remote parquet over https/s3/gs
 * is how models read data. Only the local filesystem is confined. Measured on
 * DuckDB 1.4.4: /etc/hosts, /proc/self/environ and ~ refused; remote reads and
 * spilling to the scratch directory work; nothing can be widened afterwards.
 *
 * What a model loses: reading local files outside its scratch directory —
 * including data files in its own repo, which none of the published repos do —
 * and autoloading an extension mid-query (list it in `additionalExtensions`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Remote locations DuckDB may still read. String prefixes, as DuckDB compares them. */
const REMOTE_PREFIXES = [
  "https://",
  "http://",
  "s3://",
  "s3a://",
  "s3n://",
  "gs://",
  "gcs://",
  "r2://",
  "az://",
  "azure://",
  "abfss://",
  "hf://",
  "md:",
  "motherduck:",
] as const;

/** Connection properties OURS to set: a repo's value would undo the recipe. */
const OVERRIDDEN = ["enableExternalAccess", "allowedDirectories", "lockConfiguration", "tempDirectory", "extensionDirectory"];

export class DuckDBSandboxError extends Error {}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Extensions are installed here once and shared; reading it is never allowed after setup. */
function extensionDirectory(): string {
  const dir = path.join(os.tmpdir(), "malloyyo-duckdb-extensions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A private directory per connection: its spill files and its (unused) secrets. */
export function makeScratchRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-duckdb-"));
}

export function discardScratchRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** The SQL that confines one connection to `scratch`. Runs before the repo's own setupSQL. */
export function sandboxSetupSQL(scratch: string): string {
  const allowed = [`${scratch.replace(/\/+$/, "")}/`, ...REMOTE_PREFIXES].map(sqlString).join(", ");
  return [
    `SET home_directory=${sqlString(scratch)}`,
    `SET allowed_directories=[${allowed}]`,
    "SET enable_external_access=false",
    `SET secret_directory=${sqlString(path.join(scratch, ".secrets"))}`,
  ].join(";\n");
}

/** The options a sandboxed DuckDB connection is built with (for direct construction). */
export function sandboxConnectionOptions(scratch: string, setupSQL?: string): Record<string, unknown> {
  return {
    tempDirectory: scratch,
    extensionDirectory: extensionDirectory(),
    setupSQL: setupSQL ? `${sandboxSetupSQL(scratch)};\n${setupSQL}` : sandboxSetupSQL(scratch),
    lockConfiguration: true,
  };
}

function isAllowedDatabasePath(p: unknown): boolean {
  if (p === undefined || p === ":memory:" || p === "") return true;
  return typeof p === "string" && (p.startsWith("md:") || p.startsWith("motherduck:"));
}

/**
 * Apply the recipe to every `duckdb` connection in a config's JSON.
 *
 * Throws DuckDBSandboxError for what can't be sandboxed: a local `databasePath`
 * (DuckDB opens it with full access, before any of this applies) or a
 * `setupSQL`/`databasePath` given as a reference, which this can't see into.
 * A connection that already asks for Malloy's `securityPolicy: "sandboxed"` is
 * left alone — it confines the filesystem itself, more tightly.
 */
export function sandboxDuckDBConnections(configJson: string, scratchRoot: string): string {
  let parsed: { connections?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    // The model won't load either, and the compiler says why far better.
    return configJson;
  }
  const connections = parsed.connections ?? {};
  for (const [name, entry] of Object.entries(connections)) {
    if (!entry || typeof entry !== "object" || entry.is !== "duckdb") continue;
    if (entry.securityPolicy === "sandboxed") continue;
    const where = `connection "${name}"`;
    if (entry.databasePath !== undefined && !isAllowedDatabasePath(entry.databasePath)) {
      throw new DuckDBSandboxError(
        `${where}: databasePath must be :memory: or a MotherDuck path (md:…) on this server — ` +
          `a local database file would be opened before the file sandbox applies`,
      );
    }
    if (entry.path !== undefined && !isAllowedDatabasePath(entry.path)) {
      throw new DuckDBSandboxError(`${where}: path must be :memory: or a MotherDuck path (md:…) on this server`);
    }
    if (entry.setupSQL !== undefined && typeof entry.setupSQL !== "string") {
      throw new DuckDBSandboxError(`${where}: setupSQL must be written out, not a reference`);
    }
    const scratch = path.join(scratchRoot, name.replace(/[^A-Za-z0-9_-]/g, "_") || "duckdb");
    fs.mkdirSync(scratch, { recursive: true });
    for (const key of OVERRIDDEN) delete entry[key];
    // "local" only cuts the network; the recipe confines files and needs the
    // network for the extensions. Ordinary DuckDB plus the recipe is stricter
    // where it matters here.
    delete entry.securityPolicy;
    Object.assign(entry, sandboxConnectionOptions(scratch, (entry.setupSQL as string | undefined)?.trim() || undefined));
  }
  return JSON.stringify(parsed);
}
