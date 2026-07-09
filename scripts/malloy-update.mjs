#!/usr/bin/env node
// Update every @malloydata/* dependency to its latest published version.
//
// NOTE: npm has no "minimum release age" guard (pnpm did — the repo dropped it
// when it moved to npm). `npm install @malloydata/*@latest` therefore takes
// whatever is newest right now, including any fresh transitive deps the new
// malloydata versions pull in. Review the diff before committing.
//
//   npm run malloy-update                 # do it
//   npm run malloy-update -- --dry-run    # show latest available, touch nothing
//   npm run malloy-update -- --current    # report what's installed now (offline)
//   npm run --silent malloy-update -- --json   # machine-readable result on stdout
//
// --json: human chatter (and npm's output) is routed to stderr; the only thing
// written to stdout is a single JSON object. The shape depends on the mode:
//
//   default / --dry-run:
//     { "primary": "0.0.417",        // @malloydata/malloy target version
//       "self":    "0.2.3",          // this repo's @malloydata/malloyyo version
//       "changed": true,             // did any @malloydata/* pin move?
//       "packages": [ { "name", "from", "to" }, … ] }
//
//   --current (no network, no write — just reads the manifests on disk):
//     { "primary": "0.0.416",        // @malloydata/malloy as pinned right now
//       "self":    "0.2.3",          // this repo's @malloydata/malloyyo version
//       "packages": [ { "name", "version" }, … ] }
//
// `self` is this repo's own published package — the CLI in packages/cli, whose
// version the release mirrors into the root. It's reported so callers can record
// the before/after malloyyo version without guessing.
//
// Pair --json with `npm run --silent …` so npm's own run banner stays off stdout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry-run");
const CURRENT = ARGS.includes("--current");
const JSON_OUT = ARGS.includes("--json");

// In --json mode stdout is reserved for the result object, so every human-facing
// line goes to stderr instead.
const say = JSON_OUT ? (...a) => console.error(...a) : (...a) => console.log(...a);

const PKG_FILES = [
  "package.json",
  "packages/cli/package.json",
  "packages/mcp-engine/package.json",
];
// This repo's own published package (the CLI). Its version is the malloyyo
// release version, mirrored into the root package.json by scripts/release.ts.
const SELF_PKG = "packages/cli/package.json";
const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const npmView = (name) =>
  execFileSync("npm", ["view", name, "version"], { encoding: "utf8" }).trim();

function npm(args) {
  // In --json mode keep stdout clean: npm's chatter goes to our stderr (fd 2).
  const stdio = JSON_OUT ? ["inherit", 2, "inherit"] : "inherit";
  execFileSync("npm", args, { stdio, env: process.env });
}

// The npm `-w` flag for a manifest path (the root manifest → no flag). Used to
// target `npm install` at the workspace that actually declares each dep.
const workspaceFlag = (file) =>
  file === "package.json" ? [] : ["-w", file.replace(/\/package\.json$/, "")];

// @malloydata/* deps grouped by the manifest that declares them. peerDependencies
// are version FLOORS, not pins — leave them; only real install sections get bumped.
function malloydataByManifest() {
  const byFile = new Map();
  for (const f of PKG_FILES) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const found = new Set();
    for (const s of ["dependencies", "devDependencies", "optionalDependencies"])
      for (const k of Object.keys(j[s] ?? {}))
        if (k.startsWith("@malloydata/")) found.add(k);
    if (found.size) byFile.set(f, [...found]);
  }
  return byFile;
}

// Map of @malloydata/* name -> pinned version (range prefix stripped), read from
// the manifests as they currently are on disk. This is the source of truth for
// what an install would resolve, so before/after snapshots come from here.
function readPins() {
  const pins = new Map();
  for (const f of PKG_FILES) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    for (const s of SECTIONS)
      for (const [k, v] of Object.entries(j[s] ?? {}))
        if (k.startsWith("@malloydata/") && !pins.has(k))
          pins.set(k, String(v).replace(/^[^\d]*/, ""));
  }
  return pins;
}

// This repo's own version (the malloyyo CLI).
const readSelf = () => JSON.parse(readFileSync(SELF_PKG, "utf8")).version;

// 1. discover the direct @malloydata/* deps and their current pins
const before = readPins();
if (before.size === 0) {
  console.error("No @malloydata/* dependencies found.");
  process.exit(1);
}
const names = [...before.keys()].sort();
const self = readSelf();

// --current: report only what's installed right now. No registry calls, no
// writes — instant and offline. Useful for "what malloy am I on?" before/after.
if (CURRENT) {
  const primary = before.get("@malloydata/malloy") ?? before.get(names[0]);
  say(`Currently pinned (this repo is @malloydata/malloyyo ${self}):`);
  for (const name of names) say(`  ${name}  ${before.get(name)}`);
  if (JSON_OUT) {
    const packages = names.map((name) => ({ name, version: before.get(name) }));
    process.stdout.write(JSON.stringify({ primary, self, packages }) + "\n");
  }
  process.exit(0);
}

// 2. report the latest published version of each
say(`Latest published versions for ${names.length} @malloydata/* packages:`);
const latest = new Map();
for (const name of names) {
  const v = npmView(name);
  latest.set(name, v);
  say(`  ${name}  ${before.get(name)}  ->  ${v}`);
}

const primary = latest.get("@malloydata/malloy") ?? latest.get(names[0]);

// Emit the JSON result and exit. `to` reflects the post-run pins (= `after`),
// which equals `latest` after a real update and stays at the current pin on a
// dry run. `changed` is true when any pin actually moves.
function emit(after) {
  const packages = names.map((name) => ({
    name,
    from: before.get(name),
    to: after.get(name),
  }));
  const changed = packages.some((p) => p.from !== p.to);
  if (JSON_OUT)
    process.stdout.write(
      JSON.stringify({ primary, self, changed, packages }) + "\n",
    );
  return changed;
}

if (DRY) {
  const changed = emit(latest); // nothing written; report latest as the target
  if (!JSON_OUT) say(`\n(dry run) nothing changed.${changed ? " Updates available." : " Already current."}`);
  process.exit(0);
}

// 3. let npm edit each manifest + the lockfile. `npm install <name>@latest`
//    keeps a dep in its existing section and handles the range operator, so we
//    install per workspace (npm preserves where each dep already lives).
say("\nUpdating @malloydata/* to latest…");
for (const [file, pkgNames] of malloydataByManifest()) {
  const specs = pkgNames.map((n) => `${n}@latest`);
  npm(["install", ...specs, ...workspaceFlag(file), "--no-audit", "--no-fund"]);
}

// Re-read the manifests so the reported `to` is what actually landed on disk.
const changed = emit(readPins());

say(
  changed
    ? "\n✓ Updated @malloydata/* to latest. Expect the diff to be malloydata plus" +
        "\n  any transitive deps the new versions pulled in. Review, then commit:" +
        "\n  package.json(s) and package-lock.json."
    : "\n✓ @malloydata/* already at latest — nothing changed.",
);
