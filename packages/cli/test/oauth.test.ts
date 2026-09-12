// Unit tests for the pieces of `malloyyo login` that decide HOW the browser
// round trip happens — which is what makes the command usable (or not) in a
// container, over SSH, or in CI. No network: the OAuth exchange itself is
// covered by the publish-flow integration test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  browserless,
  getAccessToken,
  listenTarget,
  looksLikeInstanceToken,
  openBrowser,
  tokenSource,
} from '../src/oauth.js';

test('listens on any free loopback port by default', () => {
  assert.deepEqual(listenTarget({}), { host: '127.0.0.1', port: 0 });
});

test('an empty MALLOYYO_OAUTH_PORT is the same as not setting it', () => {
  assert.deepEqual(listenTarget({ MALLOYYO_OAUTH_PORT: '' }), { host: '127.0.0.1', port: 0 });
});

test('a fixed port can be pinned so a container can publish it', () => {
  assert.deepEqual(listenTarget({ MALLOYYO_OAUTH_PORT: '41121' }), {
    host: '127.0.0.1',
    port: 41121,
  });
});

test('the bind host is settable, because a published port arrives off-loopback', () => {
  // Inside a container, `docker run -p` forwards to the container's own
  // interface. Bound to 127.0.0.1 there, the listener refuses the connection
  // and sign-in dies at the redirect.
  assert.deepEqual(
    listenTarget({ MALLOYYO_OAUTH_PORT: '41121', MALLOYYO_OAUTH_HOST: '0.0.0.0' }),
    { host: '0.0.0.0', port: 41121 },
  );
});

test('a port that is not a port is rejected by name', () => {
  for (const bad of ['abc', '0', '-1', '70000', '1.5', ' ']) {
    assert.throws(
      () => listenTarget({ MALLOYYO_OAUTH_PORT: bad }),
      /MALLOYYO_OAUTH_PORT/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('macOS and Windows always have a browser to open', () => {
  assert.equal(browserless('darwin', {}), false);
  assert.equal(browserless('win32', {}), false);
});

test('Linux has a browser only when a display server is present', () => {
  assert.equal(browserless('linux', {}), true);
  assert.equal(browserless('linux', { DISPLAY: ':0' }), false);
  assert.equal(browserless('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false);
});

/** Whether `name` is executable on PATH — used to run the next test only where
    the opener really is missing, so it never launches a browser on a laptop. */
function onPath(name: string): boolean {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, name)));
}

const openerMissing = process.platform === 'linux' && !onPath('xdg-open');

test(
  'a missing browser opener does not take the process down',
  {
    skip: openerMissing ? false : 'needs a Linux host with no xdg-open (a container)',
  },
  async () => {
    // spawn() reports ENOENT asynchronously as an 'error' event. With no
    // listener Node rethrows it as an uncaught exception, which killed the CLI
    // one line after it printed the URL meant to be the fallback. If that
    // listener is ever removed, this test process dies here instead of failing.
    openBrowser('http://127.0.0.1:1/never-opened');
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(true, 'still running after the opener failed');
  },
);

// ── where a bearer token comes from ─────────────────────────────────────────
//
// Precedence is load-bearing: CI sets $MALLOYYO_TOKEN and has no credentials
// file, while a laptop has a login and (too often) a stale export. Getting the
// order wrong means one of those two silently uses the wrong credential.

const TARGET = { name: 'prod', url: 'https://yo.example.com', dataset: 'movies' };
const CONFIGURED = { ...TARGET, tokenEnv: 'YO_PROD_TOKEN' };

test('--token wins over every environment variable', async () => {
  const env = { YO_PROD_TOKEN: 'from-config-env', MALLOYYO_TOKEN: 'from-global-env' };
  assert.equal(tokenSource(CONFIGURED, { tokenFlag: 'from-flag' }, env), 'flag');
  assert.equal(await getAccessToken(CONFIGURED, { tokenFlag: 'from-flag' }, env), 'from-flag');
});

test("a target's own token env var beats the ambient one", async () => {
  // Someone publishing to main AND staging from one shell needs a credential
  // per instance; $MALLOYYO_TOKEN can only hold one of them.
  const env = { YO_PROD_TOKEN: 'from-config-env', MALLOYYO_TOKEN: 'from-global-env' };
  assert.equal(tokenSource(CONFIGURED, {}, env), 'env');
  assert.equal(await getAccessToken(CONFIGURED, {}, env), 'from-config-env');
});

test('$MALLOYYO_TOKEN is used when the config names no variable', async () => {
  const env = { MALLOYYO_TOKEN: 'from-global-env' };
  assert.equal(tokenSource(TARGET, {}, env), 'global-env');
  assert.equal(await getAccessToken(TARGET, {}, env), 'from-global-env');
});

test('an empty or unset variable falls through to the stored login', () => {
  assert.equal(tokenSource(TARGET, {}, {}), 'login');
  assert.equal(tokenSource(TARGET, {}, { MALLOYYO_TOKEN: '' }), 'login');
  assert.equal(tokenSource(CONFIGURED, {}, { YO_PROD_TOKEN: '' }), 'login');
  // A named-but-empty config var still lets the ambient one through.
  assert.equal(
    tokenSource(CONFIGURED, {}, { YO_PROD_TOKEN: '', MALLOYYO_TOKEN: 'from-global-env' }),
    'global-env',
  );
});

test('a minted instance token is recognizable, and other secrets are not', () => {
  // This is advice-only (it never gates a request), but it is the difference
  // between "invalid or revoked token" and "is that variable still your
  // warehouse password?".
  assert.equal(looksLikeInstanceToken(`myo_stg_${'a'.repeat(43)}`), true);
  assert.equal(looksLikeInstanceToken('myo_main_aa_bb-ccddeeffgghhiijjkkll'), true);
  for (const other of [
    '',
    'myo_stg_short',
    'Ck1rQmJ3S2xvR2hRc3VwZXJzZWNyZXRhY2Nlc3N0b2s', // an OAuth access token
    'eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uIjoiYWJjIn0.sig', // a MotherDuck token
  ]) {
    assert.equal(looksLikeInstanceToken(other), false, `should not match: ${other}`);
  }
});
