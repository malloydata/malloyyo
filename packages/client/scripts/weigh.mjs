// Measure what `npm i @malloydata/malloyyo-client` actually costs, by packing
// this package and installing the tarball into a throwaway directory.
//
// This exists because the client's whole reason to be separate from the CLI is
// install weight: the CLI pulls 661 packages / ~47s / 530MB (BigQuery, Snowflake,
// DuckDB, the renderer, Vega…), which is dead weight for a process that only
// ever compiles. A dependency added here silently is a regression in the one
// number this package is for, so the budget below is deliberately tight enough
// to notice — @malloydata/malloy alone is ~50 packages.
//
// Run: npm run weigh   (needs network; not part of `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Malloy is BUNDLED (scripts/build.mjs), so a correct install resolves exactly
// one package: this one. The budget is 2 rather than 1 only so a deliberate,
// reviewed dependency does not have to land together with a threshold bump —
// anything more means something crept into `dependencies` by accident.
const MAX_PACKAGES = 2;

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'malloyyo-client-weigh-'));

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

try {
  const packed = JSON.parse(sh('npm', ['pack', '--json', '--pack-destination', work], pkgDir));
  const tarball = path.join(work, packed[0].filename);

  sh('npm', ['init', '-y'], work);
  const started = Date.now();
  const out = sh('npm', ['install', tarball, '--no-audit', '--no-fund'], work);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const added = /added (\d+) package/.exec(out);
  const packages = added ? Number(added[1]) : NaN;
  const mb = (dirBytes(path.join(work, 'node_modules')) / 1024 / 1024).toFixed(0);

  console.log(`packages: ${packages}`);
  console.log(`install:  ${seconds}s`);
  console.log(`on disk:  ${mb} MB`);

  if (Number.isNaN(packages)) {
    console.error('\ncould not parse npm output — weigh needs updating');
    process.exitCode = 1;
  } else if (packages > MAX_PACKAGES) {
    console.error(
      `\nFAIL: ${packages} packages exceeds the ${MAX_PACKAGES}-package budget.\n` +
        'This package exists to be small — a clean install is 1 package in ~0.5s,\n' +
        'against the full CLI\'s 661 in ~47s. Bundle the new dependency into\n' +
        'dist/main.cjs (scripts/build.mjs) rather than declaring it, or raise\n' +
        'MAX_PACKAGES deliberately and say why.',
    );
    process.exitCode = 1;
  } else {
    console.log(`\nOK: within the ${MAX_PACKAGES}-package budget.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
