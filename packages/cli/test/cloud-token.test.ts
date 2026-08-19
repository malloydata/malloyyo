// Turning the credential into an access token, against the control plane.
//
// Oracle: RFC 6749 — §4.4.2 for the request (form-encoded, `grant_type=client_credentials`,
// space-delimited `scope`), §5.1 for the success body. A separately owned standard, and the
// same one the control plane implements from its side.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../src/cloud/api.js';
import {
  createCachedTokenSource,
  createCredentialExchange,
  type AccessTokenGrant,
} from '../src/cloud/token-source.js';
import { USER_AGENT } from '../src/http.js';

const SECRET = 'client-secret-do-not-leak-me';

const CONFIG = {
  apiUrl: 'https://api.example.com/',
  clientId: 'client-1',
  clientSecret: SECRET,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stubs global `fetch` — what `apiFetch` calls — capturing the request it saw. */
function stub(respond: () => { status?: number; body?: unknown }): { seen: () => Request } {
  let captured: Request | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = new Request(url, init);
    const { status = 200, body } = respond();
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return {
    seen: () => {
      assert.ok(captured, 'fetch was never called');
      return captured;
    },
  };
}

const GRANT = { access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600 };

describe('createCredentialExchange', () => {
  test('posts the credential to the control plane, form-encoded, with the scopes asked for', async () => {
    const f = stub(() => ({ body: GRANT }));

    const grant = await createCredentialExchange(CONFIG)(['instances:read', 'instances:create']);

    const request = f.seen();
    // The trailing slash on apiUrl must not double up.
    assert.equal(request.url, 'https://api.example.com/v1/token');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), 'application/x-www-form-urlencoded');
    // The exchange is a call to a Malloyyo server like any other, so it identifies itself.
    assert.equal(request.headers.get('user-agent'), USER_AGENT);

    const sent = new URLSearchParams(await request.text());
    assert.equal(sent.get('grant_type'), 'client_credentials');
    assert.equal(sent.get('client_id'), 'client-1');
    assert.equal(sent.get('client_secret'), SECRET);
    assert.equal(sent.get('scope'), 'instances:read instances:create');

    assert.deepEqual(grant, { accessToken: 'tok-abc', expiresIn: 3600 });
  });

  test('omits scope entirely rather than sending it empty', async () => {
    // Absent means "everything this credential may do"; empty would ask for a token that can
    // do nothing, which is a different request and a useless token.
    const f = stub(() => ({ body: GRANT }));

    await createCredentialExchange(CONFIG)([]);

    assert.equal(new URLSearchParams(await f.seen().text()).has('scope'), false);
  });

  test('turns a rejected credential into a sentence naming what to check', async () => {
    // The server says only `invalid_client`, on purpose — it must not reveal whether the ID
    // exists. This side knows which two environment variables the values came from, so this
    // is where the actionable wording has to come from.
    stub(() => ({ status: 401, body: { error: 'invalid_client' } }));

    await assert.rejects(
      () => createCredentialExchange(CONFIG)(['instances:read']),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.status, 401);
        assert.equal(error.code, 'invalid_client');
        assert.match(error.message, /MALLOYYO_CLIENT_ID/);
        assert.match(error.message, /MALLOYYO_CLIENT_SECRET/);
        return true;
      },
    );
  });

  test('fails as a ControlPlaneError, so a transient failure is retried like any other', async () => {
    // A 5xx on the token request is exactly as transient as a 5xx on the request it was for.
    // Throwing a plain Error here would make the client treat it as final and give up.
    stub(() => ({ status: 503, body: { error: 'unavailable' } }));

    await assert.rejects(
      () => createCredentialExchange(CONFIG)(['instances:read']),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.status, 503);
        return true;
      },
    );
  });

  test('refuses a 200 that carries no token rather than returning undefined', async () => {
    stub(() => ({ body: { token_type: 'Bearer' } }));

    await assert.rejects(
      () => createCredentialExchange(CONFIG)(['instances:read']),
      /no access token/,
    );
  });
});

describe('createCachedTokenSource', () => {
  /** Counts exchanges and hands back a distinguishable token each time. */
  function counting(expiresIn = 3600): {
    exchange: (scopes: readonly string[]) => Promise<AccessTokenGrant>;
    calls: () => number;
    scopesSeen: () => readonly string[][];
  } {
    let calls = 0;
    const scopesSeen: readonly string[][] = [];
    const seen: string[][] = scopesSeen as string[][];
    return {
      exchange: async (scopes) => {
        seen.push([...scopes]);
        calls += 1;
        return { accessToken: `tok-${calls}`, expiresIn };
      },
      calls: () => calls,
      scopesSeen: () => scopesSeen,
    };
  }

  test('exchanges once and reuses the token', async () => {
    // A create polls its operation, so without this every poll would be a second round trip
    // before the one it actually wanted.
    const { exchange, calls } = counting();
    const source = createCachedTokenSource(exchange, ['instances:read'], { now: () => 0 });

    assert.equal(await source.getAccessToken(), 'tok-1');
    assert.equal(await source.getAccessToken(), 'tok-1');
    assert.equal(calls(), 1);
  });

  test('re-exchanges before expiry, not after', async () => {
    // The skew covers clock drift and flight time. Renewing exactly at expiry means handing
    // out a token that dies somewhere between here and the server.
    const { exchange } = counting(3600);
    let nowMs = 0;
    const source = createCachedTokenSource(exchange, ['instances:read'], {
      now: () => nowMs,
      refreshSkewSeconds: 60,
    });

    assert.equal(await source.getAccessToken(), 'tok-1');
    // One second before the renew point (3600 - 60 = 3540s) it is still the same token.
    nowMs = 3_539_000;
    assert.equal(await source.getAccessToken(), 'tok-1');
    nowMs = 3_540_000;
    assert.equal(await source.getAccessToken(), 'tok-2');
  });

  test('shares one in-flight exchange between concurrent callers', async () => {
    // On a cold cache, several requests at once would otherwise each start an exchange and
    // throw all but one away.
    const { exchange, calls } = counting();
    const source = createCachedTokenSource(exchange, ['instances:read'], { now: () => 0 });

    const tokens = await Promise.all([
      source.getAccessToken(),
      source.getAccessToken(),
      source.getAccessToken(),
    ]);

    assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
    assert.equal(calls(), 1);
  });

  test('asks only for the scopes it was built with', async () => {
    const { exchange, scopesSeen } = counting();
    const source = createCachedTokenSource(exchange, ['instances:read'], { now: () => 0 });

    await source.getAccessToken();

    assert.deepEqual(scopesSeen(), [['instances:read']]);
  });
});
