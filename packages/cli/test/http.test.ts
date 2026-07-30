// Unit test for `apiFetch` — the single wrapper every CLI call to a
// Malloyyo-operated server goes through. `fetch` is stubbed; no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, USER_AGENT } from '../src/http.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub `fetch`, capturing the request it was called with. */
function stub(response: Response): { seen: () => Request } {
  let captured: Request | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = new Request(url, init);
    return response;
  }) as unknown as typeof fetch;
  return {
    seen: () => {
      assert.ok(captured, 'fetch was never called');
      return captured;
    },
  };
}

test('identifies the CLI and its version on every request', async () => {
  const f = stub(new Response('{}', { status: 200 }));
  await apiFetch('https://malloyyo.example/api/thing');

  // The server side reads this to see which CLI versions are still in the
  // field, so both halves matter: the product name and a real version.
  assert.match(f.seen().headers.get('user-agent') ?? '', /^malloyyo\/\d+\.\d+\.\d+/);
  assert.equal(f.seen().headers.get('user-agent'), USER_AGENT);
});

test('adds the user agent without dropping the caller\'s headers', async () => {
  const f = stub(new Response('{}', { status: 200 }));
  await apiFetch('https://malloyyo.example/api/thing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' },
    body: '{}',
  });

  const req = f.seen();
  assert.equal(req.headers.get('authorization'), 'Bearer t0ken');
  assert.equal(req.headers.get('content-type'), 'application/json');
  assert.equal(req.headers.get('user-agent'), USER_AGENT);
  assert.equal(req.method, 'POST');
});

test('turns 426 into an upgrade instruction naming the floor and the command', async () => {
  stub(new Response(JSON.stringify({ minimum_version: '0.4.0' }), { status: 426 }));

  await assert.rejects(
    () => apiFetch('https://malloyyo.example/api/thing'),
    (err: Error) => {
      assert.match(err.message, /0\.4\.0/); // the floor the server asked for
      assert.match(err.message, /npm i -g @malloydata\/malloyyo/); // how to fix it
      return true;
    },
  );
});

test('still explains a 426 that carries no minimum version', async () => {
  stub(new Response('not json', { status: 426 }));

  await assert.rejects(
    () => apiFetch('https://malloyyo.example/api/thing'),
    /npm i -g @malloydata\/malloyyo/,
  );
});

test('passes ordinary failures through untouched', async () => {
  // Callers report their own errors with server detail; swallowing a 400 or a
  // 500 here would hide it.
  for (const status of [400, 401, 404, 500]) {
    stub(new Response('{"error":"nope"}', { status }));
    const res = await apiFetch('https://malloyyo.example/api/thing');
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: 'nope' }); // body still readable
  }
});
