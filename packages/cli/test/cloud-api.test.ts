// The control-plane client's wire behavior.
//
// The oracle is the control plane's own HTTP contract, which it pins from its side: method
// + path, the
// `{ instance }` / `{ instances }` / `{ operation }` / `{ instance, operation }` wrapping,
// the required `Idempotency-Key` on mutations, and the `{ error, message }` error body.
// These tests pin that this CLI speaks it.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ControlPlaneClient,
  ControlPlaneError,
  createControlPlaneClient,
} from '../src/cloud/api.js';
import { USER_AGENT } from '../src/http.js';

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/**
 * `body` is JSON-encoded; `raw` is sent verbatim, for the answers that do not come from the
 * control plane at all (an HTML error page from a proxy in front of it). A `respond` that
 * throws stands in for a transport failure.
 */
function harness(
  respond: (recorded: Recorded) => { status?: number; body?: unknown; raw?: string },
  options: { maxAttempts?: number } = {},
): { client: ControlPlaneClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const recorded: Recorded = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(recorded);
    const { status = 200, body, raw } = respond(recorded);
    const text = raw ?? (body === undefined ? '' : JSON.stringify(body));
    return new Response(text, { status });
  };

  const client = createControlPlaneClient({
    apiUrl: 'https://api.example.com/',
    getAccessToken: async () => 'tok-123',
    fetch: fetchImpl,
    sleep: async () => undefined,
    ...options,
  });
  return { client, calls };
}

const INSTANCE = {
  id: 'ten_1',
  slug: 'acme',
  lifecycle: 'creating',
  hostname: 'acme.malloyyo.com',
  desired: { version: 'sha256:abc', cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
  observed: { version: null, running: null, at: null },
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};
const OPERATION = {
  id: 'op_1',
  instanceId: 'ten_1',
  kind: 'create',
  status: 'running',
  error: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  finishedAt: null,
};

describe('createControlPlaneClient', () => {
  test('POSTs a create with the bearer token, an Idempotency-Key, and the slug body', async () => {
    const { client, calls } = harness(() => ({
      status: 202,
      body: { instance: INSTANCE, operation: OPERATION },
    }));

    const result = await client.createInstance({ slug: 'acme', idempotencyKey: 'key-1' });

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, 'POST');
    // The trailing slash on apiUrl must not double up in the path.
    assert.equal(call.url, 'https://api.example.com/v1/instances');
    assert.equal(call.headers.get('authorization'), 'Bearer tok-123');
    assert.equal(call.headers.get('idempotency-key'), 'key-1');
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), { slug: 'acme' });
    assert.equal(result.instance.id, 'ten_1');
    assert.equal(result.operation.id, 'op_1');
  });

  test('unwraps a single instance, a list, and an operation from their envelopes', async () => {
    const one = harness(() => ({ body: { instance: INSTANCE } }));
    assert.equal((await one.client.getInstance('ten_1')).slug, 'acme');

    const many = harness(() => ({ body: { instances: [INSTANCE] } }));
    assert.equal((await many.client.listInstances()).length, 1);

    const op = harness(() => ({ body: { operation: OPERATION } }));
    assert.equal((await op.client.getOperation('op_1')).status, 'running');
  });

  test('sends DELETE with an Idempotency-Key', async () => {
    const { client, calls } = harness(() => ({
      body: { instance: INSTANCE, operation: { ...OPERATION, kind: 'delete' } },
    }));

    const result = await client.deleteInstance({ id: 'ten_1', idempotencyKey: 'key-2' });

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, 'DELETE');
    assert.equal(call.url, 'https://api.example.com/v1/instances/ten_1');
    assert.equal(call.headers.get('idempotency-key'), 'key-2');
    assert.equal(result.operation?.kind, 'delete');
  });

  test('returns a null operation from a delete, which the contract allows', async () => {
    // The documented answer for an instance already in a terminal delete state that no
    // operation row explains. Treating it as an error would break exactly the retry path the
    // delete's Idempotency-Key exists for.
    const { client } = harness(() => ({
      body: { instance: { ...INSTANCE, lifecycle: 'destroyed' }, operation: null },
    }));

    const result = await client.deleteInstance({ id: 'ten_1', idempotencyKey: 'key-3' });

    assert.equal(result.operation, null);
    assert.equal(result.instance.lifecycle, 'destroyed');
  });

  test('turns a non-2xx `{ error, message }` into a ControlPlaneError with the status', async () => {
    const { client } = harness(() => ({
      status: 409,
      body: { error: 'slug_taken', message: 'the name "acme" is already in use' },
    }));

    await assert.rejects(
      () => client.createInstance({ slug: 'acme', idempotencyKey: 'key-1' }),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'slug_taken');
        assert.match(error.message, /already in use/);
        return true;
      },
    );
  });

  test('falls back to the error code when the body carries no message', async () => {
    const { client } = harness(() => ({ status: 403, body: { error: 'missing_scope' } }));

    await assert.rejects(
      () => client.listInstances(),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.message, 'missing_scope');
        return true;
      },
    );
  });

  test('keeps the status when the answer is not JSON at all', async () => {
    // An HTML error page from something in front of the control plane, or MALLOYYO_API_URL
    // pointing at something that is not the control plane. The status is the whole
    // diagnosis, so parsing must not be what decides whether the caller sees it.
    const { client } = harness(() => ({ status: 502, raw: '<html>Bad gateway</html>' }), {
      maxAttempts: 1,
    });

    await assert.rejects(
      () => client.listInstances(),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.status, 502);
        assert.match(error.message, /MALLOYYO_API_URL/);
        return true;
      },
    );
  });

  test('rejects a 2xx that carries no `instance`, naming the missing field', async () => {
    const { client } = harness(() => ({ body: { somethingElse: {} } }));

    await assert.rejects(() => client.getInstance('ten_1'), /carried no `instance`/);
  });

  test('retries a 5xx under the same Idempotency-Key, which is what makes it safe', async () => {
    // A fresh key on the retry would turn a lost answer into a second instance, or a 409 on a
    // slug the caller themselves just took.
    let attempts = 0;
    const { client, calls } = harness(() => {
      attempts += 1;
      return attempts < 3
        ? { status: 503, body: { error: 'unavailable' } }
        : { status: 202, body: { instance: INSTANCE, operation: OPERATION } };
    });

    await client.createInstance({ slug: 'acme', idempotencyKey: 'key-1' });

    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.headers.get('idempotency-key')),
      ['key-1', 'key-1', 'key-1'],
    );
  });

  test('does not retry a 4xx — the answer is final and a second attempt says the same thing', async () => {
    const { client, calls } = harness(() => ({ status: 409, body: { error: 'slug_taken' } }));

    await assert.rejects(() => client.createInstance({ slug: 'acme', idempotencyKey: 'key-1' }));

    assert.equal(calls.length, 1);
  });

  test('does not retry a busy conflict at this layer', async () => {
    // `secrets set` waits it out itself, on a much longer clock than a transient retry.
    const { client, calls } = harness(() => ({ status: 409, body: { error: 'instance_busy' } }));

    await assert.rejects(
      () => client.setInstanceSecrets({ id: 'ten_1', values: { A: 'b' }, idempotencyKey: 'k' }),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.code, 'instance_busy');
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  test('POSTs the pairs under `secrets` with an Idempotency-Key, and reads back names', async () => {
    const { client, calls } = harness(() => ({
      status: 202,
      body: {
        instance: INSTANCE,
        operation: { ...OPERATION, kind: 'set_secrets' },
        secrets: [{ name: 'PG_HOST' }, { name: 'PG_PASSWORD' }],
      },
    }));

    const result = await client.setInstanceSecrets({
      id: 'ten_1',
      values: { PG_HOST: 'db.example.com', PG_PASSWORD: 'hunter2' },
      idempotencyKey: 'key-9',
    });

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.example.com/v1/instances/ten_1/secrets');
    assert.equal(call.headers.get('idempotency-key'), 'key-9');
    assert.deepEqual(JSON.parse(call.body ?? ''), {
      secrets: { PG_HOST: 'db.example.com', PG_PASSWORD: 'hunter2' },
    });
    // Names come back; there is no field on this endpoint that could carry a value.
    assert.deepEqual(result.secrets, [{ name: 'PG_HOST' }, { name: 'PG_PASSWORD' }]);
  });
});

// The port's own wiring, and the reason the user agent was a prerequisite for it.
//
// The standalone CLI this came from called global `fetch` directly. Here every call to a
// Malloyyo-operated server goes through `apiFetch`, so the control plane can see which CLI
// versions are in the field before it changes anything — the compatibility rule is "one
// wrapper covers instance and control-plane calls alike", and a client that quietly kept its
// own `fetch` would satisfy the type and break the rule.
describe('the control-plane client and the shared HTTP wrapper', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stubs global `fetch` — what `apiFetch` calls — and captures the request it saw. */
  function stubGlobalFetch(response: Response): { seen: () => Request } {
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

  test('identifies the CLI and its version on a control-plane call', async () => {
    const f = stubGlobalFetch(new Response(JSON.stringify({ instances: [] }), { status: 200 }));
    // No `fetch` injected: this exercises the default, which is the thing under test.
    const client = createControlPlaneClient({
      apiUrl: 'https://api.example.com',
      getAccessToken: async () => 'tok-123',
    });

    await client.listInstances();

    assert.equal(f.seen().headers.get('user-agent'), USER_AGENT);
    // And the bearer token still gets through — the wrapper adds, it does not replace.
    assert.equal(f.seen().headers.get('authorization'), 'Bearer tok-123');
  });

  test('turns the control plane saying "too old" into an upgrade instruction', async () => {
    // A schema validation error the customer has to decode is the failure this replaces.
    stubGlobalFetch(new Response(JSON.stringify({ minimum_version: '0.4.0' }), { status: 426 }));
    const client = createControlPlaneClient({
      apiUrl: 'https://api.example.com',
      getAccessToken: async () => 'tok-123',
      sleep: async () => undefined,
    });

    await assert.rejects(() => client.listInstances(), /npm i -g @malloydata\/malloyyo/);
  });
});
