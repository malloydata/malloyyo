#!/usr/bin/env node
// Update every @malloydata/* dependency to its latest published version,
// regardless of pnpm's minimum-release-age guard, then regenerate the
// age-exclude allowlist from the full resolved lockfile (direct + transitive)
// so later installs don't re-block the fresh versions.
//
//   npm run malloy-update                 # do it
//   npm run malloy-update -- --dry-run    # show latest versions, touch nothing
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
//    does not). The release-age guard is disabled just for this run.
console.log("\nUpdating to latest (minimum-release-age disabled for this run)…");
pnpm([
  "update",
  "--recursive",
  "--latest",
  "--config.minimumReleaseAge=0",
  ...[...names],
]);

// 4. regenerate the age-exclude list from EVERY @malloydata package now in the
//    lockfile (direct + transitive), so age-gated installs accept the fresh set
const lock = readFileSync("pnpm-lock.yaml", "utf8");
const specs = new Set();
const re = /(@malloydata\/[^@\s'"()]+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;
for (let m; (m = re.exec(lock)); ) specs.add(`${m[1]}@${m[2]}`);

const block =
  "minimumReleaseAgeExclude:\n" +
  [...specs].sort().map((s) => `  - '${s}'`).join("\n") +
  "\n";

let ws = readFileSync("pnpm-workspace.yaml", "utf8");
if (/^minimumReleaseAgeExclude:/m.test(ws)) {
  // replace only the header + its indented list items; leave other keys intact
  ws = ws.replace(/^minimumReleaseAgeExclude:\n(?:[ \t]+-.*\n?)*/m, block);
} else {
  ws = ws.replace(/\n*$/, "\n\n") + block;
}
writeFileSync("pnpm-workspace.yaml", ws);

console.log(
  `\n✓ Updated @malloydata/* to latest; age-exclude now lists ${specs.size} packages.`,
);
console.log(
  "  Review the diff, then commit: package.json(s), pnpm-lock.yaml, pnpm-workspace.yaml",
);
