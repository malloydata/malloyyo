#!/usr/bin/env tsx
/**
 * Release the repo: the `malloyyo` CLI to npm, and the version the server
 * reports.
 *
 * EVERY merge to main is the signal to release. The version in
 * packages/cli/package.json is the source of truth, reconciled against the
 * registry:
 *
 *   - version already on npm   -> ordinary merge, the PR carried no bump:
 *       patch-bump, publish, commit the bump back + tag.
 *   - version NOT on npm        -> the PR carried its own semver bump:
 *       publish it as-is + tag. No commit (the version is already in the repo).
 *
 * ONE NUMBER covers both packages. It is written to packages/cli/package.json,
 * the repo-root @malloyyo/server package.json, and all three version fields in
 * package-lock.json.
 *
 * This reverses an earlier decision to keep them apart. That decision read the
 * number as a compatibility claim — "a CLI patch that bumped it would report
 * every deployment as out of date" — and it left the server's number frozen at
 * 0.2.31 through six CLI releases, so a running server could not say what code
 * it was. The number is an IDENTITY, not a claim: if two deployments differ,
 * their numbers should differ, and a deployment six releases behind saying so is
 * the point rather than a bug. Compatibility still comes from the server staying
 * backward compatible (see src/http.ts), which was always the real mechanism.
 *
 * The commit deliberately carries NO [skip ci] — see the commit step for why,
 * and for the guard that replaced it.
 *
 * The mcp-engine is internal and unpublished — it is NOT versioned here (it
 * stays pinned at 0.0.1).
 *
 * Auth is supplied by the environment, so CI and humans run the identical
 * command: npm trusted publishing (OIDC) in CI, or a personal npm token /
 * `npm login` when an authorized person runs it from the command line.
 *
 * Run `npm run release -- --help` for the full guided walkthrough.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative, resolve, sep} from 'node:path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgJsonPath = join(pkgDir, 'package.json');
const repoRoot = join(pkgDir, '..', '..');
const lockPath = join(repoRoot, 'package-lock.json');
// The server's manifest. Its version is compiled into the build
// (src/lib/version.ts imports it), so moving it here is what lets a running
// server say which code it is.
const rootPkgJsonPath = join(repoRoot, 'package.json');

/**
 * Point package-lock.json at the release version too.
 *
 * The lock records the version of each workspace, so a release that rewrites
 * package.json without it leaves the two permanently out of step. That is
 * exactly what happened: the lock sat at 0.2.19 while package.json reached
 * 0.2.25, so any contributor running `npm install` got a spurious diff to
 * notice and discard. (`npm ci` tolerates it — it only checks that the lock
 * satisfies the dependencies — so this was noise, not a broken build.)
 *
 * BOTH the CLI workspace entry and the root entries are written, because one
 * version now covers both packages (see the header). The root version appears
 * twice — top-level `version` and `packages[""].version` — and writing only one
 * leaves the other to show up as a spurious diff on the next `npm install`.
 *
 * Edited surgically rather than with `npm install --package-lock-only`, which
 * re-resolves the whole tree and would let unrelated dependency bumps ride into
 * a release commit. npm writes this file as `JSON.stringify(…, null, 2)`, so a
 * parse/serialise round-trip is byte-identical and the diff stays on the
 * version field.
 */
export function syncLockVersion(version: string, path: string = lockPath): boolean {
  const text = readFileSync(path, 'utf8');
  const lock = JSON.parse(text);
  // The workspace is keyed by its repo-relative path, always POSIX-separated.
  const cliKey = relative(repoRoot, pkgDir).split(sep).join('/');
  // Every place the lock records a version we release. A missing field throws
  // rather than being skipped: a lock whose shape has changed should abort the
  // release, not quietly ship a server whose version did not move.
  const setVersion = (holder: unknown, where: string): void => {
    const entry = holder as {version?: unknown} | undefined;
    if (!entry || typeof entry.version !== 'string') {
      throw new Error(`package-lock.json: no version field at ${where}`);
    }
    entry.version = version;
  };
  setVersion(lock.packages?.[cliKey], `packages["${cliKey}"]`);
  setVersion(lock.packages?.[''], 'packages[""]');
  setVersion(lock, 'the top level');
  const next = JSON.stringify(lock, null, 2) + '\n';
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
}

/**
 * Point the server's manifest at the release version.
 *
 * Same surgical edit as the lock, and for the same reason: npm writes
 * package.json as `JSON.stringify(…, null, 2)`, so a round-trip is
 * byte-identical and the diff stays on the version field. `npm version` is not
 * used because it would need a second child process and a cwd change to reach
 * the root workspace, and it writes a lock as a side effect we have already
 * handled.
 */
export function syncRootVersion(version: string, path: string = rootPkgJsonPath): boolean {
  const text = readFileSync(path, 'utf8');
  const pkg = JSON.parse(text) as {version?: unknown};
  if (typeof pkg.version !== 'string') {
    throw new Error('package.json (repo root): no version field');
  }
  pkg.version = version;
  const next = JSON.stringify(pkg, null, 2) + '\n';
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
}

// ---------------------------------------------------------------------------
// tiny presentation helpers
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s: string): string => c('1', s);
const dim = (s: string): string => c('2', s);
const green = (s: string): string => c('32', s);
const yellow = (s: string): string => c('33', s);
const red = (s: string): string => c('31', s);
const cyan = (s: string): string => c('36', s);

const ok = (s: string): void => console.log(`${green('✓')} ${s}`);
const warn = (s: string): void => console.log(`${yellow('!')} ${s}`);
const info = (s: string): void => console.log(`${cyan('›')} ${s}`);
const step = (s: string): void => console.log(`\n${bold(s)}`);
function die(msg: string, fix?: string): never {
  console.error(`\n${red('✗')} ${bold(msg)}`);
  if (fix) console.error(`\n${fix}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------
function run(cmd: string, args: string[], opts: {quiet?: boolean} = {}): string {
  if (!opts.quiet) console.log(dim(`  > ${cmd} ${args.join(' ')}`));
  return (
    execFileSync(cmd, args, {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: opts.quiet ? 'pipe' : 'inherit',
    })
      ?.toString()
      .trim() ?? ''
  );
}
function silent(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {cwd: pkgDir, encoding: 'utf8'}).toString().trim();
  } catch {
    return null;
  }
}
const succeeds = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, {cwd: pkgDir, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
};

function readPkg(): {name: string; version: string} {
  return JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
}
const isPublished = (name: string, version: string): boolean =>
  succeeds('npm', ['view', `${name}@${version}`, 'version']);
const packageExists = (name: string): boolean =>
  succeeds('npm', ['view', name, 'version']);

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const a = (await rl.question(`${question} ${dim('[y/N]')} `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
function help(): void {
  const {name, version} = readPkg();
  console.log(`
${bold(`Release ${name} to npm`)}

${bold('WHAT IT DOES')}
  A merge to main is the signal to publish. This script looks at the version in
  ${cyan('packages/cli/package.json')} (currently ${green(version)}) and compares it to npm:

    ${bold('• version is already on npm')}  -> the PR didn't bump it, so this is a
        routine release: bump a ${bold('patch')}, publish, then commit the bumped
        version back to main and push a tag.

    ${bold('• version is NOT on npm')}      -> the PR already bumped it (you chose the
        major/minor/patch in the PR): publish that exact version and tag it.
        Nothing is committed — the version is already in the repo.

  So: to cut a normal patch, do nothing — just merge. To cut a minor/major,
  bump the version in ${cyan('package.json')} inside your PR and merge.

  This releases the CLI alone. The repo-root ${cyan('@malloyyo/server')} keeps its own
  version — the two are released separately.

${bold('USAGE')}
  ${cyan('npm run release')}                 cut a release (prompts before publishing locally)
  ${cyan('npm run release -- --dry-run')}    build + ${cyan('npm publish --dry-run')}; touches nothing
  ${cyan('npm run release -- --no-push')}    publish + commit/tag locally, but don't push
  ${cyan('npm run release -- --yes')}        skip the confirmation prompt
  ${cyan('npm run release -- --help')}       this message

${bold('AUTH (you do not pass a token)')}
  ${bold('In CI')}    npm trusted publishing (OIDC). No secrets. Provenance is automatic.
  ${bold('Locally')}  your own npm account. Run ${cyan('npm login')} first (or set a token in
            ${cyan('~/.npmrc')}). You must have publish rights on ${cyan(name)}. Local
            publishes are real and valid; they just don't carry the provenance badge.

${bold('FIRST PUBLISH / SETUP')}
  On npmjs.com, register ${cyan(name)} with a trusted publisher pointing at this
  repo + ${cyan('.github/workflows/cli-publish.yml')}, and leave token publishing enabled
  so this command keeps working from your laptop too.

${bold('SAFE TO RE-RUN')}
  If a run publishes but dies before pushing, just run it again: it detects the
  already-published version, skips the publish, and finishes the git side.
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Drop a bare `--` separator (npm forwards it through `npm run release -- …`).
  const argv = process.argv.slice(2).filter((a) => a !== "--");

  if (argv.includes('-h') || argv.includes('--help')) {
    help();
    return;
  }

  const known = new Set(['--dry-run', '--no-push', '--yes', '-y']);
  const unknown = argv.filter(a => !known.has(a));
  if (unknown.length) {
    die(
      `Unknown option(s): ${unknown.join(', ')}`,
      `Run ${cyan('npm run release -- --help')} to see the available options.`
    );
  }

  const dryRun = argv.includes('--dry-run');
  const noPush = argv.includes('--no-push');
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const isCI = !!process.env.CI;
  const interactive = process.stdin.isTTY && !isCI;

  const {name, version: inRepo} = readPkg();

  console.log(bold(`\n📦 Releasing ${name}`));
  if (dryRun) info('DRY RUN — nothing will be published, committed, or pushed.');

  // --- preflight -----------------------------------------------------------
  step('Preflight');

  if (!succeeds('git', ['rev-parse', '--is-inside-work-tree'])) {
    die('Not inside a git repository.', 'Run this from a checkout of the malloyyo repo.');
  }

  const branch = silent('git', ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '?';
  if (branch === 'main') {
    ok('On branch main.');
  } else {
    warn(
      `On branch ${yellow(branch)}, not ${bold('main')}. Releases are normally cut from main.`
    );
  }

  const status = run('git', ['status', '--porcelain'], {quiet: true});
  if (status) {
    if (dryRun) {
      warn('Working tree is dirty (ignored in dry-run).');
    } else {
      die(
        'Working tree is not clean.',
        `This script commits + tags, so the tree must be clean. Uncommitted changes:\n\n${dim(
          status
        )}\n\nCommit or stash them, then re-run. (Use ${cyan('--dry-run')} to preview safely.)`
      );
    }
  } else {
    ok('Working tree is clean.');
  }

  if (isCI) {
    ok('CI detected — publishing via npm trusted publishing (OIDC).');
  } else {
    const who = silent('npm', ['whoami']);
    if (who) {
      ok(`npm: logged in as ${green(who)}.`);
    } else if (dryRun) {
      warn('Not logged in to npm (fine for a dry run).');
    } else {
      die(
        'Not logged in to npm.',
        `Trusted publishing only works in CI, so a local publish needs your account.\nRun ${cyan(
          'npm login'
        )} (you must have publish rights on ${cyan(
          name
        )}), then re-run.\nOr preview safely with ${cyan('npm run release -- --dry-run')}.`
      );
    }
  }

  // --- decide the version --------------------------------------------------
  step('Deciding the version');
  info(`Version in package.json: ${bold(inRepo)}`);

  if (!packageExists(name)) {
    info(`${cyan(name)} has never been published — this will be the first release.`);
  }

  // Captured before `npm version` runs — it rewrites the lock as a side effect,
  // so these are the only faithful copies to roll back to if the release aborts.
  const lockBefore = readFileSync(lockPath, 'utf8');
  const rootPkgBefore = readFileSync(rootPkgJsonPath, 'utf8');

  let version = inRepo;
  let bumped = false;
  if (isPublished(name, inRepo)) {
    // Routine merge: the PR didn't bump. Patch-bump to the next AVAILABLE
    // version, skipping any already on npm. A version can be "taken but not in
    // the repo" if a prior run published it but then failed before pushing the
    // bump commit (e.g. the old rebase-on-dirty-tree bug that stranded 0.2.17):
    // a plain single bump would land on that hole and get skipped at publish,
    // stalling every release. Looping past it self-heals.
    do {
      run('npm', ['version', '--no-git-tag-version', 'patch']);
      version = readPkg().version;
    } while (isPublished(name, version));
    bumped = true;
    ok(`${name}@${inRepo} is already on npm → patch bump to first free version ${green(version)}.`);
  } else {
    ok(`${name}@${inRepo} is not on npm → publishing ${green(version)} as-is.`);
  }

  const lockSynced = syncLockVersion(version);
  if (lockSynced) ok(`Synced package-lock.json → ${green(version)}.`);
  const rootSynced = syncRootVersion(version);
  if (rootSynced) ok(`Synced the server's package.json → ${green(version)}.`);

  const tag = `malloyyo-v${version}`;
  const restoreVersion = (): void => {
    if (bumped) run('npm', ['version', '--no-git-tag-version', inRepo], {quiet: true});
    // Unconditional: `npm version` may have touched the lock even when we didn't.
    writeFileSync(lockPath, lockBefore);
    writeFileSync(rootPkgJsonPath, rootPkgBefore);
  };

  // --- the plan ------------------------------------------------------------
  step('Plan');
  console.log(`  publish      ${bold(`${name}@${version}`)} → npm (tag: latest)`);
  console.log(`  tag          ${tag}`);
  console.log(
    `  lock sync    ${lockSynced ? `yes — package-lock.json → ${green(version)}` : dim('no (already in sync)')}`
  );
  console.log(
    `  server sync  ${rootSynced ? `yes — package.json → ${green(version)}` : dim('no (already in sync)')}`
  );
  console.log(
    `  commit back  ${
      bumped || lockSynced || rootSynced
        ? `yes — "${`release: v${version}`}"`
        : dim('no (version already in repo)')
    }`
  );
  console.log(
    `  push         ${
      noPush
        ? yellow('no (--no-push)')
        : bumped || lockSynced || rootSynced
          ? 'commit + tag → origin/main'
          : 'tag → origin'
    }`
  );
  console.log(`  auth         ${isCI ? 'OIDC (trusted publishing)' : 'your npm login'}`);

  if (dryRun) {
    info('\nDry run — will build and run `npm publish --dry-run`, then restore.');
  } else if (interactive && !assumeYes) {
    if (!(await confirm(`\nProceed and ${bold('publish for real')}?`))) {
      restoreVersion();
      die('Aborted.', `Nothing was published. Re-run when ready, or use ${cyan('--dry-run')}.`);
    }
  }

  // --- execute -------------------------------------------------------------
  try {
    step('Build');
    run('npm', ['run', 'build']); // builds the engine, then bundles the CLI
    step('Typecheck');
    run('npm', ['run', 'typecheck']);

    step('Publish');
    if (isPublished(name, version)) {
      warn(`${name}@${version} is already on npm — skipping publish (finishing git side).`);
    } else if (dryRun) {
      run('npm', ['publish', '--dry-run']);
      restoreVersion();
      console.log(`\n${green('✓')} ${bold(`Dry run OK`)} — would publish ${name}@${version}.`);
      return;
    } else {
      run('npm', ['publish']); // auth from env: OIDC in CI, token locally
      ok(`Published ${green(`${name}@${version}`)}.`);
    }

    if (dryRun) {
      restoreVersion();
      return;
    }

    step('Git');
    // lockSynced or rootSynced can be the ONLY reason to commit: a release that
    // publishes the in-repo version as-is still has to carry a lock or a server
    // manifest that drifted earlier.
    const committed = bumped || lockSynced || rootSynced;
    if (committed) {
      const files: string[] = [];
      if (bumped) files.push(pkgJsonPath);
      if (lockSynced) files.push(lockPath);
      if (rootSynced) files.push(rootPkgJsonPath);
      // NO [skip ci]. This commit has to trigger docker-publish.yml so the
      // server image is rebuilt from the bumped manifest — that rebuild is what
      // makes the new version real. The `release:` prefix is what stops the
      // release re-triggering ITSELF: cli-publish.yml skips a head commit whose
      // message starts with it. Change this string and you must change that
      // workflow's `if:` in the same commit.
      run('git', ['commit', '-m', `release: v${version}`, ...files]);
    }
    if (!succeeds('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
      run('git', ['tag', tag]);
    }
    if (noPush) {
      warn('--no-push: leaving the commit + tag local. Push them yourself when ready.');
    } else {
      if (committed) {
        // --autostash: the lock is committed above, but the build/typecheck
        // steps can still leave other files dirty, and unstaged changes abort a
        // rebase ("cannot pull with rebase: You have unstaged changes"). Stash
        // across the rebase and restore after.
        run('git', ['pull', '--rebase', '--autostash', 'origin', 'main']);
        run('git', ['push', 'origin', 'HEAD:main']);
      }
      run('git', ['push', 'origin', tag]);
    }

    // --- done --------------------------------------------------------------
    console.log(`\n${green('✓')} ${bold(`Released ${name}@${version}`)}`);
    console.log(`  npm      https://www.npmjs.com/package/${name}/v/${version}`);
    console.log(`  install  ${cyan(`npm i -g ${name}@${version}`)}`);
    console.log(`  tag      ${tag}`);
  } catch {
    restoreVersion();
    die(
      'Release failed.',
      `The version in package.json was restored to ${inRepo}. See the error above.\nIf the publish itself succeeded but a later step failed, just re-run — it's safe.`
    );
  }
}

// Run only when invoked as a script, so a test can import the version-writing
// functions above without releasing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
