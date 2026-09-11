// Unit tests for the device-flow half of `malloyyo login`: which flow the CLI
// picks, and the poll loop that waits on a human. No network — the token
// endpoint is a scripted sequence of responses, and the clock and the sleeps
// are injected, so ten minutes of polling take no time at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFlow, pollDeviceToken, type PollDeps } from '../src/oauth.js';
import { UpgradeRequiredError } from '../src/http.js';

// --- chooseFlow --------------------------------------------------------------

test('a laptop keeps the loopback redirect, whatever the server advertises', () => {
  assert.equal(chooseFlow({}, {}, 'darwin'), 'loopback');
  assert.equal(chooseFlow({}, {}, 'win32'), 'loopback');
  assert.equal(chooseFlow({}, { DISPLAY: ':0' }, 'linux'), 'loopback');
});

test('no browser means the device flow: a container, SSH, CI', () => {
  assert.equal(chooseFlow({}, {}, 'linux'), 'device');
});

test('--device wins everywhere', () => {
  assert.equal(chooseFlow({ device: true }, { DISPLAY: ':0' }, 'darwin'), 'device');
});

test('a pinned MALLOYYO_OAUTH_PORT means the user arranged for the redirect', () => {
  // Browserless, but they published a port — that is a deliberate loopback setup.
  assert.equal(chooseFlow({}, { MALLOYYO_OAUTH_PORT: '41121' }, 'linux'), 'loopback');
  // Unless they also asked for the device flow outright.
  assert.equal(chooseFlow({ device: true }, { MALLOYYO_OAUTH_PORT: '41121' }, 'linux'), 'device');
});

test('--no-browser alone does not change the flow', () => {
  // Printing the URL instead of opening it is about the browser launch; the
  // redirect still comes back to this machine.
  assert.equal(chooseFlow({ noBrowser: true }, { DISPLAY: ':0' }, 'linux'), 'loopback');
});

// --- pollDeviceToken ---------------------------------------------------------

type Step =
  | { status: number; json: unknown }
  | { status: number; text: string }
  | { throws: string | Error };

function json(status: number, body: unknown): Step {
  return { status, json: body };
}
const pending = json(400, { error: 'authorization_pending' });
const granted = json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });

/** A token endpoint that answers `steps` in order, plus the record of what the
    loop did between calls. */
function scripted(steps: Step[]) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const warnings: string[] = [];
  let calls = 0;
  const deps: PollDeps = {
    fetch: async () => {
      const step = steps[calls++];
      if (!step) throw new Error(`the loop polled ${calls} times; only ${steps.length} responses were scripted`);
      if ('throws' in step) throw typeof step.throws === 'string' ? new Error(step.throws) : step.throws;
      const body = 'text' in step ? step.text : JSON.stringify(step.json);
      return new Response(body, {
        status: step.status,
        statusText: step.status === 502 ? 'Bad Gateway' : '',
        headers: { 'content-type': 'text' in step ? 'text/html' : 'application/json' },
      });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    warn: (m) => warnings.push(m),
  };
  return { deps, sleeps, warnings, calls: () => calls };
}

const auth = { device_code: 'dc', expires_in: 600, interval: 5 };
const poll = (s: ReturnType<typeof scripted>) => pollDeviceToken('https://x/api/oauth/token', 'cid', auth, s.deps);

test('pending is the protocol, not a failure: the loop waits it out', async () => {
  const s = scripted([pending, pending, pending, granted]);
  const grant = await poll(s);
  assert.equal(grant.access_token, 'at');
  assert.equal(grant.refresh_token, 'rt');
  assert.deepEqual(s.sleeps, [5000, 5000, 5000, 5000], 'polls on the advertised interval');
  assert.deepEqual(s.warnings, [], 'nothing to warn about');
});

test('slow_down widens the interval by five seconds, cumulatively', async () => {
  const s = scripted([json(400, { error: 'slow_down' }), json(400, { error: 'slow_down' }), pending, granted]);
  await poll(s);
  assert.deepEqual(s.sleeps, [5000, 10000, 15000, 15000]);
});

test('a proxy hiccup mid-wait does not end a ten-minute sign-in', async () => {
  // A 502 with an HTML body is what a forwarding proxy returns while the
  // upstream restarts; a thrown fetch is a reset connection. Both happen
  // routinely in exactly the environments the device flow exists for.
  const s = scripted([
    pending,
    { status: 502, text: '<html>Bad Gateway</html>' },
    { throws: 'fetch failed' },
    json(503, { error: 'service_unavailable' }),
    pending,
    granted,
  ]);
  const grant = await poll(s);
  assert.equal(grant.access_token, 'at');
  assert.equal(s.calls(), 6);
  assert.equal(s.warnings.length, 1, 'told once, not once per retry');
  assert.match(s.warnings[0], /502 Bad Gateway/);
});

test('the terminal errors end the loop with a message the user can act on', async () => {
  for (const [error, expect] of [
    ['access_denied', /denied/],
    ['expired_token', /expired/],
    ['invalid_grant', /run login again/],
  ] as const) {
    const s = scripted([pending, json(400, { error })]);
    await assert.rejects(poll(s), expect, error);
    assert.equal(s.calls(), 2, `${error} must stop the loop`);
  }
});

test("an unknown 4xx error is the server's final word", async () => {
  const s = scripted([json(400, { error: 'invalid_request' }), granted]);
  await assert.rejects(poll(s), /sign-in failed: invalid_request/);
  assert.equal(s.calls(), 1);
});

test('the code expiring on the client side ends the wait', async () => {
  // Never anything but pending; the clock advances by each sleep.
  const s = scripted(Array.from({ length: 200 }, () => pending));
  await assert.rejects(poll(s), /timed out/);
  // 600s at 5s per poll: the loop must stop at the deadline, not run the script dry.
  assert.ok(s.calls() <= 121, `polled ${s.calls()} times past a 600s expiry`);
});

test('a 200 without a token is not a success', async () => {
  // A misbehaving proxy can answer 200 with a login page.
  const s = scripted([{ status: 200, text: '<html>Sign in</html>' }, granted]);
  const grant = await poll(s);
  assert.equal(grant.access_token, 'at');
  assert.equal(s.calls(), 2);
});

test('"upgrade the CLI" is final, not a hop to retry', async () => {
  const s = scripted([pending, { throws: new UpgradeRequiredError('This server requires 9.9.9 or newer') }, granted]);
  await assert.rejects(poll(s), /requires 9\.9\.9/);
  assert.equal(s.calls(), 2);
});
