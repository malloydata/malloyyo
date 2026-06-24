#!/usr/bin/env node
// Update every @malloydata/* dependency to its latest published version.
//
// pnpm 11 refuses any package published within the last 24h (its built-in
// `minimum-release-age` default). We do NOT disable that guard globally — doing
// so would let pnpm drag fresh, unvetted transitive deps (aws-sdk, azure, …)
// into the lockfile, which a later `--frozen-lockfile` install (CI) then
// rejects. Instead pnpm-workspace.yaml exempts the whole `@malloydata/*` scope
// from the guard (a glob, any version), so only those packages may be young —
// every other dep still has to age 24h and stays put. The update therefore runs
// with the guard ACTIVE; nothing here needs to touch the exclude list.
//
//   npm run malloy-update                 # do it
//   npm run malloy-update -- --dry-run    # show latest versions, touch nothing
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DRY = process.argv.slice(2).includes("--dry-run");

const PKG_FILES = [
  "package.json",
  "packages/cli/package.json",
  "packages/mcp-engine/package.json",
];
const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const npmView = (name) =>
  execFileSync("npm", ["view", name, "version"], { encoding: "utf8" }).trim();

// pnpm may not be on PATH directly; fall back to corepack (packageManager field).
function pnpm(args) {
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  try {
    execFileSync("pnpm", args, { stdio: "inherit", env });
  } catch (e) {
    if (e.code === "ENOENT")
      execFileSync("corepack", ["pnpm", ...args], { stdio: "inherit", env });
    else throw e;
  }
}

// 1. discover the direct @malloydata/* deps across the workspace
const names = new Set();
for (const f of PKG_FILES) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const s of SECTIONS)
    for (const k of Object.keys(j[s] ?? {}))
      if (k.startsWith("@malloydata/")) names.add(k);
}
if (names.size === 0) {
  console.error("No @malloydata/* dependencies found.");
  process.exit(1);
}

// 2. report the latest version of each
console.log(`Latest published versions for ${names.size} @malloydata/* packages:`);
for (const name of [...names].sort())
  console.log(`  ${name}  ->  ${npmView(name)}`);

if (DRY) {
  console.log("\n(dry run) nothing changed.");
  process.exit(0);
}

// 3. let pnpm edit the manifests + lockfile — it handles dependency types,
//    range operators, and duplicate entries correctly (a hand-rolled regex
//    does not). The age guard stays ON: `@malloydata/*` is exempt via
//    pnpm-workspace.yaml, so malloydata floats to latest while every other dep
//    stays aged. We DON'T pass --config.minimumReleaseAge=0 — that global
//    bypass is exactly what used to pull fresh transitive deps into the lockfile
//    and break CI's --frozen-lockfile install.
console.log("\nUpdating @malloydata/* to latest (age guard active; scope exempt)…");
pnpm(["update", "--recursive", "--latest", ...[...names]]);

console.log(
  "\n✓ Updated @malloydata/* to latest. The age guard kept every other dep" +
    "\n  aged, so the only churn should be malloydata (and any of its deps that" +
    "\n  have themselves aged ≥24h). Review the diff, then commit:" +
    "\n  package.json(s) and pnpm-lock.yaml.",
);
