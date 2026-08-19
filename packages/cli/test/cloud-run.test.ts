// Configuration and dispatch for `malloyyo cloud` — the parts that decide what runs and
// with which authority, tested without a process, a network, or real auth.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneClient } from '../src/cloud/api.js';
import { ControlPlaneError } from '../src/cloud/api.js';
import { loadCloudConfig, MissingCloudConfigError } from '../src/cloud/config.js';
import { runCloud, type CloudInvocation } from '../src/cloud/run.js';

const CREDENTIAL = {
  MALLOYYO_CLIENT_ID: 'client-1',
  MALLOYYO_CLIENT_SECRET: 'shhh-not-in-any-output',
};

describe('loadCloudConfig', () => {
  test('bakes in the API URL, so a customer sets only their credential', async () => {
    const config = loadCloudConfig({ ...CREDENTIAL });

    assert.equal(config.apiUrl, 'https://api.malloyyo.com');
    assert.equal(config.clientId, 'client-1');
  });

  test('lets the environment override the baked-in API URL', async () => {
    const config = loadCloudConfig({
      ...CREDENTIAL,
      MALLOYYO_API_URL: 'https://api.staging.malloyyo.com',
    });

    assert.equal(config.apiUrl, 'https://api.staging.malloyyo.com');
  });

  test('asks for the credential and nothing else', async () => {
    // The whole configuration surface, and it must stay this small: the control plane does
    // the credential exchange, so no identity-provider setting reaches a customer. Reporting
    // the missing values one per run would also turn setup into a guessing game.
    assert.throws(
      () => loadCloudConfig({}),
      (error: unknown) => {
        assert.ok(error instanceof MissingCloudConfigError);
        assert.deepEqual(error.names, ['MALLOYYO_CLIENT_ID', 'MALLOYYO_CLIENT_SECRET']);
        return true;
      },
    );
  });

  test('trims, because the usual mistake is a pasted trailing newline', async () => {
    const config = loadCloudConfig({ ...CREDENTIAL, MALLOYYO_CLIENT_ID: ' client-1\n' });

    assert.equal(config.clientId, 'client-1');
  });

  test('treats a blank value as absent rather than as a credential', async () => {
    assert.throws(
      () => loadCloudConfig({ ...CREDENTIAL, MALLOYYO_CLIENT_SECRET: '   ' }),
      /MALLOYYO_CLIENT_SECRET/,
    );
  });
});


/** Captures the scopes the client was built with, and returns a client that does nothing. */
function spyFactory(): {
  factory: (config: unknown, scopes: readonly string[]) => ControlPlaneClient;
  scopes: () => readonly string[];
} {
  let seen: readonly string[] = [];
  const client = {
    createInstance: async () => {
      throw new Error('not called');
    },
    getInstance: async () => {
      throw new Error('not called');
    },
    listInstances: async () => [],
    deleteInstance: async () => {
      throw new Error('not called');
    },
    setInstanceSecrets: async () => {
      throw new Error('not called');
    },
    getOperation: async () => {
      throw new Error('not called');
    },
  } as unknown as ControlPlaneClient;
  return {
    factory: (_config, scopes) => {
      seen = scopes;
      return client;
    },
    scopes: () => seen,
  };
}

function sinks(): { out: string[]; err: string[]; deps: { out: (l: string) => void; err: (l: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

describe('runCloud', () => {
  test('mints a token carrying only the scopes that command needs', async () => {
    // Least privilege: a `list` token that could create is a `list` token that can bill you.
    // The mutating commands carry read as well because they poll the operation they open,
    // and the control plane gates that GET on `instances:read`.
    const cases: Array<[CloudInvocation, readonly string[]]> = [
      [{ command: 'list' }, ['instances:read']],
      [{ command: 'create', slug: 'acme' }, ['instances:create', 'instances:read']],
      [{ command: 'delete', id: 'ten_1' }, ['instances:delete', 'instances:read']],
      [
        { command: 'secrets set', id: 'ten_1', assignments: ['A=b'], stdin: false },
        ['secrets:write', 'instances:read'],
      ],
    ];

    for (const [invocation, expected] of cases) {
      const spy = spyFactory();
      const { deps } = sinks();
      await runCloud(invocation, { env: { ...CREDENTIAL }, ...deps, makeClient: spy.factory });
      assert.deepEqual([...spy.scopes()], [...expected], `scopes for ${invocation.command}`);
    }
  });

  test('exits 2 on missing configuration, naming what to set', async () => {
    const { err, deps } = sinks();

    const code = await runCloud({ command: 'list' }, { env: {}, ...deps });

    assert.equal(code, 2);
    assert.match(err.join('\n'), /MALLOYYO_CLIENT_ID/);
  });

  test('passes a control-plane error through with its status, and exits 1', async () => {
    const { err, deps } = sinks();
    const failing = {
      listInstances: async () => {
        throw new ControlPlaneError(403, 'missing_scope', 'this token cannot list instances');
      },
    } as unknown as ControlPlaneClient;

    const code = await runCloud(
      { command: 'list' },
      { env: { ...CREDENTIAL }, ...deps, makeClient: () => failing },
    );

    assert.equal(code, 1);
    assert.match(err.join('\n'), /error \(403\): this token cannot list instances/);
  });

  test('never lets the client secret reach the output on any path', async () => {
    const { out, err, deps } = sinks();
    const failing = {
      listInstances: async () => {
        throw new Error('boom');
      },
    } as unknown as ControlPlaneClient;

    await runCloud(
      { command: 'list' },
      { env: { ...CREDENTIAL }, ...deps, makeClient: () => failing },
    );

    const everything = [...out, ...err].join('\n');
    assert.ok(!everything.includes(CREDENTIAL.MALLOYYO_CLIENT_SECRET));
  });
});
