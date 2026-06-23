#!/usr/bin/env tsx
/**
 * Release the `malloyyo` CLI to npm.
 *
 * A merge to main is the signal to release. The version in package.json is the
 * source of truth, reconciled against the registry:
 *
 *   - version already on npm   -> ordinary merge, the PR carried no bump:
 *       patch-bump, publish, commit the bump back ([skip ci]) + tag.
 *   - version NOT on npm        -> the PR carried its own semver bump:
 *       publish it as-is + tag. No commit (the version is already in the repo).
 *
 * Either way the deployed server (the repo-root @malloyyo/server package) is
 * kept in lockstep: the CLI and the server are two faces of the same repo, so
 * the release version is mirrored into the root package.json and committed with
 * the bump. The mcp-engine is internal and unpublished — it is NOT versioned
 * here (it stays pinned at 0.0.1).
 *
 * Auth is supplied by the environment, so CI and humans run the identical
 * command: npm trusted publishing (OIDC) in CI, or a personal npm token /
 * `npm login` when an authorized person runs it from the command line.
 *
 * Run `pnpm release -- --help` for the full guided walkthrough.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgJsonPath = join(pkgDir, 'package.json');
// The deployed server lives at the repo root and shares the CLI's version.
const repoRoot = join(pkgDir, '..', '..');
const rootPkgJsonPath = join(repoRoot, 'package.json');

function readVersionAt(path: string): string {
  return JSON.parse(readFileSync(path, 'utf8')).version;
}
// Rewrite only the top-level "version" field, preserving the file's formatting.
// (The first "version": occurrence is the package version; dependency pins use
// the "name": "^x.y.z" shape and never match this key.)
function writeVersionAt(path: string, version: string): void {
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text) throw new Error(`could not find a version field to update in ${path}`);
  writeFileSync(path, next);
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
        version back to main (with ${cyan('[skip ci]')}) and push a tag.

    ${bold('• version is NOT on npm')}      -> the PR already bumped it (you chose the
        major/minor/patch in the PR): publish that exact version and tag it.
        Nothing is committed — the version is already in the repo.

  So: to cut a normal patch, do nothing — just merge. To cut a minor/major,
  bump the version in ${cyan('package.json')} inside your PR and merge.

  Either way the repo-root ${cyan('package.json')} (the deployed ${cyan('@malloyyo/server')}) is
  mirrored to the same version and committed alongside — the CLI and the server
  share one version.

${bold('USAGE')}
  ${cyan('pnpm release')}                 cut a release (prompts before publishing locally)
  ${cyan('pnpm release -- --dry-run')}    build + ${cyan('npm publish --dry-run')}; touches nothing
  ${cyan('pnpm release -- --no-push')}    publish + commit/tag locally, but don't push
  ${cyan('pnpm release -- --yes')}        skip the confirmation prompt
  ${cyan('pnpm release -- --help')}       this message

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
  // Drop a bare `--` separator (pnpm forwards it through `pnpm release -- …`).
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
      `Run ${cyan('pnpm release -- --help')} to see the available options.`
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
        )}), then re-run.\nOr preview safely with ${cyan('pnpm release -- --dry-run')}.`
      );
    }
  }

  // --- decide the version --------------------------------------------------
  step('Deciding the version');
  info(`Version in package.json: ${bold(inRepo)}`);

  if (!packageExists(name)) {
    info(`${cyan(name)} has never been published — this will be the first release.`);
  }

  let version = inRepo;
  let bumped = false;
  if (isPublished(name, inRepo)) {
    run('npm', ['version', '--no-git-tag-version', 'patch']);
    version = readPkg().version;
    bumped = true;
    ok(`${name}@${inRepo} is already on npm → routine patch bump to ${green(version)}.`);
  } else {
    ok(`${name}@${inRepo} is not on npm → publishing ${green(version)} as-is.`);
  }

  // Mirror the release version into the repo-root server package.json so the
  // deployed @malloyyo/server reports the same version as the published CLI.
  const inRootRepo = readVersionAt(rootPkgJsonPath);
  const rootSynced = version !== inRootRepo;
  if (rootSynced) {
    writeVersionAt(rootPkgJsonPath, version);
    ok(`Synced server package.json ${inRootRepo} → ${green(version)}.`);
  }

  const tag = `malloyyo-v${version}`;
  const restoreVersion = (): void => {
    if (bumped) run('npm', ['version', '--no-git-tag-version', inRepo], {quiet: true});
    if (rootSynced) writeVersionAt(rootPkgJsonPath, inRootRepo);
  };

  // --- the plan ------------------------------------------------------------
  step('Plan');
  console.log(`  publish      ${bold(`${name}@${version}`)} → npm (tag: latest)`);
  console.log(`  tag          ${tag}`);
  console.log(
    `  server sync  ${rootSynced ? `yes — root package.json → ${green(version)}` : dim('no (already in sync)')}`
  );
  console.log(
    `  commit back  ${
      bumped || rootSynced
        ? `yes — "${`release: ${name} v${version} [skip ci]`}"`
        : dim('no (version already in repo)')
    }`
  );
  console.log(
    `  push         ${
      noPush ? yellow('no (--no-push)') : bumped || rootSynced ? 'commit + tag → origin/main' : 'tag → origin'
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
    const committed = bumped || rootSynced;
    if (committed) {
      const files: string[] = [];
      if (bumped) files.push(pkgJsonPath);
      if (rootSynced) files.push(rootPkgJsonPath);
      run('git', ['commit', '-m', `release: ${name} v${version} [skip ci]`, ...files]);
    }
    if (!succeeds('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
      run('git', ['tag', tag]);
    }
    if (noPush) {
      warn('--no-push: leaving the commit + tag local. Push them yourself when ready.');
    } else {
      if (committed) {
        run('git', ['pull', '--rebase', 'origin', 'main']);
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
