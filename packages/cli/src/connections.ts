// Connection-type registration, with the diagnostics that make a broken
// dependency tree say so.
//
// Importing `@malloydata/malloy-connections` is a SIDE EFFECT: it requires each
// `@malloydata/db-*` package, and each of those calls `registerConnectionType`
// on the copy of `@malloydata/malloy` that resolves from ITS OWN path. malloyyo
// then builds a `MalloyConfig` from the copy that resolves from ITS path. The
// registry is module-level state, so two physical copies of `@malloydata/malloy`
// are two separate registries — the writer and the reader never meet, and every
// connection fails with:
//
//     No connection named "duckdb" found in config
//
// which points at `malloy-config.json`, where nothing is wrong. npm nests a
// second copy as soon as anything else in the tree wants a different
// `@malloydata/malloy` version, so `npx malloyyo` inside a project that already
// carries `@malloydata/*` deps lands here routinely. (issue #136)
//
// Two byte-identical directories at different paths are still distinct module
// instances, so this is NOT a version-mismatch bug and comparing versions won't
// detect it — only comparing resolved PATHS does.
//
// So: after registration, check the registry we're going to READ actually has
// something in it, and if not, name the real cause instead of letting the
// config-lookup error take the blame.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { getRegisteredConnectionTypes } from "@malloydata/malloy";

/** The convenience package whose import registers every backend. */
const CONNECTIONS_PKG = "@malloydata/malloy-connections";

/** What `@malloydata/malloy-connections` imports, in its own order. Used only
    as the fallback when the bulk import throws — one backend with a broken
    native dependency shouldn't cost you every other connection. */
const CONNECTOR_IMPORTS = [
  "@malloydata/db-bigquery",
  "@malloydata/db-duckdb/native",
  "@malloydata/db-mysql",
  "@malloydata/db-databricks",
  "@malloydata/db-postgres",
  "@malloydata/db-snowflake",
  "@malloydata/db-trino",
];

/** Packages that WRITE to the registry — the ones whose `@malloydata/malloy`
    must be the same copy as ours for anything to work. */
const REGISTRY_WRITERS = [
  CONNECTIONS_PKG,
  "@malloydata/db-bigquery",
  "@malloydata/db-databricks",
  "@malloydata/db-duckdb",
  "@malloydata/db-mysql",
  "@malloydata/db-postgres",
  "@malloydata/db-snowflake",
  "@malloydata/db-trino",
];

/** One physical `@malloydata/malloy` install, and who resolves to it. */
export interface MalloyCopy {
  /** Real (symlink-resolved) package directory. */
  dir: string;
  version: string;
  /** Packages that resolve `@malloydata/malloy` to this copy. */
  importers: string[];
}

export interface ConnectionTypesResult {
  /** Connection types visible in OUR copy's registry. Never empty — an empty
      registry throws instead. */
  types: string[];
  /** Connector packages that failed to load, with the reason. */
  failures: { pkg: string; error: string }[];
  /** Set when more than one `@malloydata/malloy` is reachable from the
      registry writers — some registrations may have landed elsewhere. */
  duplicates: MalloyCopy[] | null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First line only — module-resolution errors trail a multi-line "Require
    stack:" that turns a one-line warning into a paragraph. */
function oneLine(text: string): string {
  return text.split("\n")[0];
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");
}

/** A `require` anchored at `dir`, for resolving as that directory would. */
function requireFrom(dir: string): NodeJS.Require {
  // createRequire wants a file path; the file needn't exist.
  return createRequire(path.join(dir, "__resolve__.cjs"));
}

/** Walk up from a resolved entry file to the directory holding its
    package.json — the fallback for packages whose `exports` map omits
    `./package.json`. */
function packageRootOf(entry: string): string | null {
  let dir = path.dirname(entry);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Directory of `spec` as resolved from `from`, or null if it isn't installed
    there. Tries the `./package.json` subpath first (cheap and exact), then the
    package's main entry (works when `exports` doesn't expose package.json). */
function packageDir(spec: string, from: string): string | null {
  const req = requireFrom(from);
  try {
    return fs.realpathSync(path.dirname(req.resolve(`${spec}/package.json`)));
  } catch {
    /* fall through — `exports` may not expose package.json */
  }
  try {
    const root = packageRootOf(req.resolve(spec));
    return root ? fs.realpathSync(root) : null;
  } catch {
    return null;
  }
}

function readVersion(pkgDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
    return String((JSON.parse(raw) as { version?: unknown }).version ?? "?");
  } catch {
    return "?";
  }
}

/** Where THIS module resolves its own dependencies from. In the shipped CLI
    that's `<malloyyo>/dist/`, so it resolves exactly as the running bin does. */
function selfDir(): string {
  return path.dirname(url.fileURLToPath(import.meta.url));
}

/**
 * Every physical `@malloydata/malloy` reachable from malloyyo and from each
 * package that registers connection types, keyed by real path. One entry means
 * a healthy tree; more than one means the registry is split.
 *
 * `from` defaults to this module's own directory — resolve as the running bin
 * does. Tests pass a fixture root.
 */
export function malloyCopies(from: string = selfDir()): MalloyCopy[] {
  const here = from;
  const byDir = new Map<string, MalloyCopy>();

  const note = (from: string | null, importer: string) => {
    if (!from) return;
    const dir = packageDir("@malloydata/malloy", from);
    if (!dir) return;
    const found = byDir.get(dir);
    if (found) {
      if (!found.importers.includes(importer)) found.importers.push(importer);
      return;
    }
    byDir.set(dir, { dir, version: readVersion(dir), importers: [importer] });
  };

  note(here, "malloyyo");
  // Resolve each writer the way it is actually reached: the db-* packages are
  // malloy-connections' dependencies, so they may only exist nested under it.
  const connectionsDir = packageDir(CONNECTIONS_PKG, here);
  for (const spec of REGISTRY_WRITERS) {
    note(packageDir(spec, connectionsDir ?? here) ?? packageDir(spec, here), spec);
  }
  return [...byDir.values()];
}

/** The duplicate-install explanation, or null when the tree is clean. */
export function duplicateMalloyReport(from?: string): string | null {
  const copies = malloyCopies(from);
  if (copies.length < 2) return null;
  const listing = copies
    .map((c) => `${c.version.padEnd(9)} ${c.dir}\n${" ".repeat(10)}↳ ${c.importers.join(", ")}`)
    .join("\n");
  return (
    `${copies.length} copies of @malloydata/malloy are installed. The connection\n` +
    `registry is module-level state, so each copy has its own: the connectors\n` +
    `register with the copy THEY resolve, malloyyo reads the copy IT resolves,\n` +
    `and when those differ every connection looks missing.\n\n` +
    `${indent(listing)}\n\n` +
    `This is about paths, not versions — two copies of the same version are still\n` +
    `two registries. Collapse the tree to one copy:\n\n` +
    `  npm ls @malloydata/malloy    # show who pulls in the extra copy\n` +
    `  npm dedupe                   # often enough on its own\n\n` +
    `Or run malloyyo somewhere that has no @malloydata/* dependencies of its own\n` +
    `(a global install, or \`npx @malloydata/malloyyo\` from an empty directory).`
  );
}

/** Import one connector by specifier, resolved from `from` so a nested install
    (db-* under malloy-connections) still loads. */
async function importConnector(spec: string, from: string): Promise<void> {
  let target = spec;
  try {
    target = url.pathToFileURL(requireFrom(from).resolve(spec)).href;
  } catch {
    /* not resolvable from there — try the bare specifier and let it throw */
  }
  await import(target);
}

let pending: Promise<ConnectionTypesResult> | null = null;

/**
 * Register every available connection type, then VERIFY the registry we read is
 * the one that was written to.
 *
 * Must complete before any `MalloyConfig` is built — the registry feeds both
 * `includeDefaultConnections` and every `is:` in malloy-config.json.
 *
 * Throws with a diagnosis (rather than letting a downstream "No connection
 * named X" take the blame) when nothing registered. Memoized: repeated calls
 * return the first result, so every command can call it unconditionally.
 */
export function loadConnectionTypes(): Promise<ConnectionTypesResult> {
  return (pending ??= register());
}

async function register(): Promise<ConnectionTypesResult> {
  const here = selfDir();
  const failures: { pkg: string; error: string }[] = [];

  try {
    await import(CONNECTIONS_PKG);
  } catch (bulk) {
    // The convenience package requires all seven backends eagerly, so ONE
    // unloadable native dependency (lz4 for Databricks, say) takes down every
    // connection with it. Retry per backend: already-loaded ones are cached
    // no-ops, and each failure is isolated to its own package.
    failures.push({ pkg: CONNECTIONS_PKG, error: message(bulk) });
    const from = packageDir(CONNECTIONS_PKG, here) ?? here;
    for (const spec of CONNECTOR_IMPORTS) {
      try {
        await importConnector(spec, from);
      } catch (e) {
        failures.push({ pkg: spec, error: message(e) });
      }
    }
  }

  const types = getRegisteredConnectionTypes();
  const duplicates = malloyCopies();
  const split = duplicates.length > 1 ? duplicates : null;

  if (types.length === 0) {
    throw new Error(noTypesRegistered(failures));
  }
  return { types, failures, duplicates: split };
}

function noTypesRegistered(failures: { pkg: string; error: string }[]): string {
  const dup = duplicateMalloyReport();
  const head =
    `0 connection types registered after loading ${CONNECTIONS_PKG} — ` +
    `no database connection can be created.\n`;
  const why = dup
    ? `\n${dup}\n`
    : `\nOnly one @malloydata/malloy was found from here, so the connector packages\n` +
      `themselves did not load or did not register. Check the install:\n\n` +
      `  npm ls @malloydata/malloy ${CONNECTIONS_PKG}\n`;
  return head + why + failureDetail(failures) + `\nNothing is wrong with your malloy-config.json.`;
}

function failureDetail(failures: { pkg: string; error: string }[]): string {
  if (failures.length === 0) return "";
  return (
    `\nConnector packages that failed to load:\n` +
    failures.map((f) => indent(`${f.pkg}: ${f.error}`)).join("\n") +
    `\n`
  );
}

/** Set once `warnConnectionIssues` has run, so repeat calls stay quiet. */
let warned = false;

/** Set once the full duplicate report has been printed, so every later error
    points back at it instead of repeating it. */
let warnedAboutDuplicates = false;

/**
 * Print anything the tree got away with — a split registry that still has some
 * types, or a backend that didn't load. Not fatal (what registered still
 * works), but it's the reason a connection later goes missing, so say it once
 * up front rather than only at the point of failure.
 *
 * stderr, so `malloyyo mcp`'s stdio protocol on stdout is untouched.
 *
 * Prints at most once per process: `initConnections` is called by every entry
 * point that touches a connection, and `dashboard dev` reaches two of them
 * (itself, then `makeRunner`).
 */
export function warnConnectionIssues(result: ConnectionTypesResult): void {
  if (warned) return;
  warned = true;
  if (result.duplicates) {
    warnedAboutDuplicates = true;
    console.error(
      `warning: ${duplicateMalloyReport()}\n` +
        `Registered so far: ${result.types.join(", ")}\n`,
    );
  }
  const backends = result.failures.filter((f) => f.pkg !== CONNECTIONS_PKG);
  for (const f of backends) {
    console.error(`warning: connection backend ${f.pkg} unavailable — ${oneLine(f.error)}`);
  }
  // The bulk import failing is normally just the first backend failing, and the
  // line above already said which. Report it on its own only when the
  // per-backend retry recovered everything — then nothing else would mention it.
  const bulk = backends.length === 0 && result.failures.find((f) => f.pkg === CONNECTIONS_PKG);
  if (bulk) {
    console.error(
      `warning: ${CONNECTIONS_PKG} failed to load (${oneLine(bulk.error)}); ` +
        `loaded each backend directly instead — connections are available.`,
    );
  }
}

/** Register connection types and report anything survivable. The one call every
    command that touches a connection should make, before building a config. */
export async function initConnections(): Promise<ConnectionTypesResult> {
  const result = await loadConnectionTypes();
  warnConnectionIssues(result);
  return result;
}

/** Core's message when a config has no entry under that name. */
const MISSING_CONNECTION = /No connection named ".*" found in config/;

/**
 * Add the context core can't have to a missing-connection error: what IS
 * registered, and whether a split registry is why the name went missing. Safe
 * on any error — non-matching messages come back untouched.
 */
export function annotateConnectionError(text: string): string {
  if (!MISSING_CONNECTION.test(text)) return text;
  const registered = getRegisteredConnectionTypes();
  const dup = duplicateMalloyReport();
  const parts = [text, ""];
  if (dup) {
    parts.push(
      warnedAboutDuplicates
        ? `This is very likely the split @malloydata/malloy install warned about above.\n`
        : `This is very likely the cause:\n\n${indent(dup)}\n`,
    );
  }
  parts.push(
    `Connection types registered: ${registered.length ? registered.join(", ") : "(none)"}`,
    `Connections come from malloy-config.json, e.g.`,
    indent(`{ "connections": { "duckdb": { "is": "duckdb" } } }`),
  );
  return parts.join("\n");
}

/** Run `fn`, re-throwing missing-connection failures with the added context. */
export async function withConnectionDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = message(e);
    const annotated = annotateConnectionError(text);
    if (annotated === text) throw e;
    throw new Error(annotated, { cause: e });
  }
}
