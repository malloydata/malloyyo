#!/usr/bin/env node
// audit-gate.mjs — the dependency gate CI runs before preflight.
//
//   node scripts/audit-gate.mjs
//
// Fails when `npm audit fix` would change package-lock.json: an advisory whose
// fix already sits inside the ranges package.json allows. That is the one
// state nobody should merge past, because the fix is a lockfile change away.
// The check is the fixer's own dry run, so it never disagrees with it.
//
// It does NOT fail on advisories that need a semver-major bump (a migration,
// taken on purpose — vega 5 → 6, say) or that have no fix at all (deep in the
// warehouse client trees). Those are printed so they stay visible.
//
// Needs the registry, so it lives in the CI workflow, not in preflight.sh
// (which is the offline gate).
import { execFileSync } from "node:child_process";

function npm(args) {
  try {
    return execFileSync("npm", [...args, "--json", "--no-fund"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    // npm exits 1 whenever audit finds anything; the JSON is still on stdout.
    if (!e.stdout) throw e;
    return e.stdout;
  }
}
// The report is the first JSON object on stdout (npm may print a text line first).
const parse = (s) => JSON.parse(s.slice(s.indexOf("{")));

// 1. What is out there, production deps only — for the record.
const audit = parse(npm(["audit", "--omit=dev"]));
const t = audit.metadata?.vulnerabilities ?? {};
console.log(
  `audit (prod deps): ${t.critical ?? 0} critical, ${t.high ?? 0} high, ` +
    `${t.moderate ?? 0} moderate, ${t.low ?? 0} low`,
);
const serious = Object.values(audit.vulnerabilities ?? {}).filter((v) =>
  ["high", "critical"].includes(v.severity),
);
const list = (label, rows, extra = () => "") => {
  if (!rows.length) return;
  console.log(`\n${label}:`);
  for (const v of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${v.severity.padEnd(8)} ${v.name}${extra(v)}`);
  }
};
list(
  "needs a semver-major bump (a deliberate migration)",
  serious.filter((v) => typeof v.fixAvailable === "object"),
  (v) => ` → ${v.fixAvailable.name}@${v.fixAvailable.version}`,
);
list(
  "no in-range fix npm can apply",
  serious.filter((v) => typeof v.fixAvailable !== "object"),
);

// 2. The gate: would `npm audit fix` change the lockfile?
const plan = parse(npm(["audit", "fix", "--dry-run", "--package-lock-only"]));
const changes = [
  ...(plan.add ?? []).map((p) => `add ${p.name}@${p.version}`),
  ...(plan.remove ?? []).map((p) => `remove ${p.name}@${p.version}`),
  ...(plan.change ?? [])
    .filter((c) => c.from?.version !== c.to?.version)
    .map((c) => `change ${c.from?.name ?? c.name} ${c.from?.version} → ${c.to?.version}`),
];
if (changes.length) {
  console.error("\n✗ `npm audit fix` would change package-lock.json:");
  for (const c of changes) console.error(`  ${c}`);
  console.error("\nRun `npm audit fix`, commit package-lock.json, and re-push.");
  process.exit(1);
}
console.log("\n✓ npm audit fix has nothing to apply");
