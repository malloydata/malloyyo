// The `cloud` command handlers, driven through an injected control-plane client so there is
// no network, no real clock, and no process.
//
// Oracles: the control plane's documented response contract for the shapes, and the
// architecture record's stated rules for the verbs — a secret value is never printed, a
// bare NAME under a pipe fails rather than hangs, `secrets set` waits out a busy instance
// under the same key, and an operation the CLI stopped waiting on has not failed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError, type ControlPlaneClient, type Instance, type Operation } from '../src/cloud/api.js';
import {
  type CommandContext,
  createCommand,
  deleteCommand,
  InvalidSecretArgumentError,
  listCommand,
  parseSecretArguments,
  parseSecretLines,
  secretsListCommand,
  secretsSetCommand,
  secretsUnsetCommand,
  statusCommand,
} from '../src/cloud/commands.js';

const PASSWORD = 'pg-password-do-not-print-me';

function instance(over: Partial<Instance> = {}): Instance {
  return {
    id: 'ten_1',
    slug: 'acme',
    lifecycle: 'active',
    hostname: 'acme.malloyyo.com',
    desired: { version: 'sha256:abc', cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
    observed: { version: null, running: null, at: null },
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function op(over: Partial<Operation> = {}): Operation {
  return {
    id: 'op_1',
    instanceId: 'ten_1',
    kind: 'create',
    status: 'succeeded',
    error: null,
    createdAt: '',
    finishedAt: null,
    ...over,
  };
}

/** Returns each queued value in turn, then repeats the last one. */
function sequence<T>(...values: T[]): () => Promise<T> {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)] as T;
}

function fakeClient(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    createInstance: async () => ({ instance: instance(), operation: op({ status: 'running' }) }),
    getInstance: async () => instance(),
    listInstances: async () => [instance()],
    deleteInstance: async () => ({
      instance: instance(),
      operation: op({ status: 'running', kind: 'delete' }),
    }),
    getOperation: async () => op({ status: 'succeeded' }),
    setInstanceSecrets: async () => ({
      instance: instance(),
      operation: op({ status: 'running', kind: 'set_secrets' }),
      secrets: [{ name: 'PG_PASSWORD' }],
    }),
    unsetInstanceSecrets: async () => ({
      instance: instance(),
      operation: op({ status: 'running', kind: 'unset_secrets' }),
      secrets: [{ name: 'PG_PASSWORD', removed: true }],
    }),
    listInstanceSecrets: async () => ({
      instance: instance(),
      secrets: [
        { name: 'PG_HOST', digest: 'sha256:aaa' },
        { name: 'PG_PASSWORD', digest: 'sha256:bbb' },
      ],
    }),
    ...overrides,
  };
}

function contextFor(
  client: ControlPlaneClient,
  over: Partial<CommandContext> = {},
): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: CommandContext = {
    client,
    out: (line) => lines.push(line),
    json: false,
    newIdempotencyKey: () => 'idem-fixed',
    sleep: async () => undefined,
    pollIntervalMs: 1,
    maxOperationWaitMs: 1_000,
    busyPollIntervalMs: 1,
    maxBusyWaitMs: 1_000,
    ...over,
  };
  return { ctx, lines };
}

describe('instance create', () => {
  test('polls to success, prints each step once, and hands back the way in', async () => {
    // The steps arrive cumulatively, as the control plane reports them; a step already
    // printed must not print again on the next poll.
    const client = fakeClient({
      getOperation: sequence(
        op({ status: 'running', steps: [{ key: 'create_database', at: 't1' }] }),
        op({
          status: 'succeeded',
          steps: [
            { key: 'create_database', at: 't1' },
            { key: 'start_instance', at: 't2' },
          ],
        }),
      ),
    });
    const { ctx, lines } = contextFor(client);

    const code = await createCommand(ctx, { slug: 'acme' });
    const output = lines.join('\n');

    assert.equal(code, 0);
    assert.equal(output.match(/Creating your database/g)?.length, 1);
    assert.match(output, /Starting your instance/);
    // A create that ends without saying where to sign in leaves someone holding an ID.
    assert.match(output, /Sign in at https:\/\/acme\.malloyyo\.com/);
    // And the next thing they will actually do — which is add the config block first.
    // Nothing in this toolchain writes malloy-config.json, so printing `publish` without
    // the block told people to run a command that fails on a missing target.
    assert.match(output, /Add this to malloy-config\.json/);
    assert.match(output, /"acme": \{ "url": "https:\/\/acme\.malloyyo\.com", "dataset"/);
    assert.match(output, /malloyyo login && malloyyo publish/);
  });

  test('says nothing but JSON under --json, so the output parses', async () => {
    const client = fakeClient({
      getOperation: async () =>
        op({ status: 'succeeded', steps: [{ key: 'create_database', at: 't1' }] }),
    });
    const { ctx, lines } = contextFor(client, { json: true });

    await createCommand(ctx, { slug: 'acme' });

    const parsed = JSON.parse(lines.join('\n')) as { instance: { slug: string } };
    assert.equal(parsed.instance.slug, 'acme');
  });

  test('exits non-zero when the operation fails, reporting the server’s reason', async () => {
    const client = fakeClient({
      getOperation: async () =>
        op({ status: 'failed', error: 'provisioning failed at setup_check' }),
    });
    const { ctx, lines } = contextFor(client);

    const code = await createCommand(ctx, { slug: 'acme' });

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /setup_check/);
  });

  test('stops waiting without failing, and says the giving up is ours', async () => {
    // The operation keeps running server-side. Reporting it as a failure would tell someone
    // their instance is broken when it is merely still being built — but the message must
    // also not read as a report on the instance's health. It is a report on the CLI.
    let clock = 0;
    const client = fakeClient({ getOperation: async () => op({ status: 'running' }) });
    const { ctx, lines } = contextFor(client, {
      now: () => (clock += 400),
      maxOperationWaitMs: 1_000,
    });

    const code = await createCommand(ctx, { slug: 'acme' });
    const output = lines.join('\n');

    assert.equal(code, 0);
    assert.match(output, /Stopped waiting/);
    // Whose giving up this is — the sentence that was missing when a create failed
    // seconds after the CLI walked away calling it "in progress".
    assert.match(output, /the CLI giving up, not the create failing/);
    assert.match(output, /malloyyo cloud instance status/);
  });

  test('reads once more at the deadline, so a status that landed in the last sleep is seen', async () => {
    // The loop sleeps between polls. Without a final read the reported status is a whole
    // interval stale, which is how a create that had already failed got reported as running.
    let clock = 0;
    const client = fakeClient({
      getOperation: sequence(
        op({ status: 'running' }),
        op({ status: 'running' }),
        op({ status: 'failed', error: 'provisioning failed at start_instance' }),
      ),
    });
    const { ctx, lines } = contextFor(client, {
      now: () => (clock += 400),
      maxOperationWaitMs: 1_000,
    });

    const code = await createCommand(ctx, { slug: 'acme' });

    // The failure is reported as a failure, not as "still in progress".
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /create failed/);
  });
});

describe('instance delete', () => {
  test('succeeds on a null operation, which is the documented retry answer', async () => {
    const client = fakeClient({
      deleteInstance: async () => ({
        instance: instance({ lifecycle: 'destroyed' }),
        operation: null,
      }),
      getInstance: async () => instance({ lifecycle: 'destroyed' }),
    });
    const { ctx, lines } = contextFor(client);

    const code = await deleteCommand(ctx, { id: 'ten_1' });

    assert.equal(code, 0);
    assert.match(lines.join('\n'), /already destroyed/);
  });
});

describe('instance status and list', () => {
  test('status prints the instance, and list says so when there are none', async () => {
    const { ctx: statusCtx, lines: statusLines } = contextFor(fakeClient());
    assert.equal(await statusCommand(statusCtx, { id: 'ten_1' }), 0);
    assert.match(statusLines.join('\n'), /acme {2}\(ten_1\)/);

    const { ctx: emptyCtx, lines: emptyLines } = contextFor(
      fakeClient({ listInstances: async () => [] }),
    );
    assert.equal(await listCommand(emptyCtx), 0);
    assert.equal(emptyLines.join('\n'), 'no instances.');
  });
});

describe('secrets set', () => {
  test('waits out a busy instance under the same key, and says so once', async () => {
    // A busy answer opens no operation, which is what makes retrying under the same key
    // safe. Announcing per attempt would read as thrashing.
    const busy = new ControlPlaneError(409, 'instance_busy', 'another operation is running');
    const keys: string[] = [];
    let attempts = 0;
    const client = fakeClient({
      setInstanceSecrets: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        attempts += 1;
        if (attempts < 3) throw busy;
        return {
          instance: instance(),
          operation: op({ status: 'succeeded', kind: 'set_secrets' }),
          secrets: [{ name: 'PG_PASSWORD' }],
        };
      },
    });
    const { ctx, lines } = contextFor(client);

    const code = await secretsSetCommand(ctx, {
      id: 'ten_1',
      assignments: [`PG_PASSWORD=${PASSWORD}`],
    });

    assert.equal(code, 0);
    assert.deepEqual(keys, ['idem-fixed', 'idem-fixed', 'idem-fixed']);
    assert.equal(lines.join('\n').match(/waiting…/g)?.length, 1);
  });

  test('never puts a value in the output, only names', async () => {
    const { ctx, lines } = contextFor(fakeClient());

    await secretsSetCommand(ctx, {
      id: 'ten_1',
      assignments: ['PG_HOST=db.example.com', `PG_PASSWORD=${PASSWORD}`],
    });

    const output = lines.join('\n');
    assert.ok(!output.includes(PASSWORD), 'the value reached the output');
    assert.match(output, /PG_HOST, PG_PASSWORD/);
  });

  test('prompts for a bare NAME, and sends what was typed', async () => {
    let sent: Record<string, string> | undefined;
    const client = fakeClient({
      setInstanceSecrets: async ({ values }) => {
        sent = { ...values };
        return {
          instance: instance(),
          operation: op({ status: 'succeeded', kind: 'set_secrets' }),
          secrets: [{ name: 'PG_PASSWORD' }],
        };
      },
    });
    const { ctx } = contextFor(client, { promptSecret: async () => PASSWORD });

    await secretsSetCommand(ctx, {
      id: 'ten_1',
      assignments: ['PG_HOST=db.example.com', 'PG_PASSWORD'],
    });

    assert.deepEqual(sent, { PG_HOST: 'db.example.com', PG_PASSWORD: PASSWORD });
  });

  test('a bare NAME with no terminal fails with the fix, rather than hanging', async () => {
    // No `promptSecret` is exactly the "stdin is a pipe" case. Waiting on input that is never
    // coming is the failure this replaces.
    const { ctx } = contextFor(fakeClient());

    await assert.rejects(
      () => secretsSetCommand(ctx, { id: 'ten_1', assignments: ['PG_PASSWORD'] }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSecretArgumentError);
        assert.match(error.message, /--stdin/);
        return true;
      },
    );
  });

  test('reads NAME=value lines from stdin when asked', async () => {
    let sent: Record<string, string> | undefined;
    const client = fakeClient({
      setInstanceSecrets: async ({ values }) => {
        sent = { ...values };
        return {
          instance: instance(),
          operation: op({ status: 'succeeded', kind: 'set_secrets' }),
          secrets: [{ name: 'PG_PASSWORD' }],
        };
      },
    });
    const { ctx } = contextFor(client, {
      readStdin: async () => `PG_HOST=db.example.com\nPG_PASSWORD=${PASSWORD}\n`,
    });

    await secretsSetCommand(ctx, { id: 'ten_1', assignments: [], stdin: true });

    assert.deepEqual(sent, { PG_HOST: 'db.example.com', PG_PASSWORD: PASSWORD });
  });

  test('refuses to guess when --stdin and arguments are both given', async () => {
    const { ctx } = contextFor(fakeClient(), { readStdin: async () => 'PG_HOST=x\n' });

    await assert.rejects(
      () => secretsSetCommand(ctx, { id: 'ten_1', assignments: ['PG_USER=app'], stdin: true }),
      /not as arguments/,
    );
  });

  test('reports a failed roll with the public step name, and still no value', async () => {
    const client = fakeClient({
      getOperation: async () =>
        op({
          status: 'failed',
          kind: 'set_secrets',
          // The public step name, which is what the control plane puts on the wire — it
          // translates `roll_warm` before a customer ever sees it.
          error: 'applying secrets failed at update_instance',
        }),
    });
    const { ctx, lines } = contextFor(client);

    const code = await secretsSetCommand(ctx, {
      id: 'ten_1',
      assignments: [`PG_PASSWORD=${PASSWORD}`],
    });

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /update_instance/);
    assert.ok(!lines.join('\n').includes(PASSWORD));
  });
});

describe('secrets unset', () => {
  test('reports removals and answers a typo honestly, then waits for the roll', async () => {
    // Oracle: the control plane's documented response — `removed: false` is a name that
    // was not set, and the verb succeeds anyway because the state the user asked for is
    // the state they have.
    const client = fakeClient({
      unsetInstanceSecrets: async ({ names }) => ({
        instance: instance(),
        operation: op({ status: 'running', kind: 'unset_secrets' }),
        secrets: names.map((name) => ({ name, removed: name !== 'PG_TYPO' })),
      }),
      getOperation: sequence(op({ status: 'succeeded', kind: 'unset_secrets' })),
    });
    const { ctx, lines } = contextFor(client);

    const code = await secretsUnsetCommand(ctx, { id: 'ten_1', names: ['PG_HOST', 'PG_TYPO'] });

    assert.equal(code, 0);
    const output = lines.join('\n');
    assert.match(output, /removing PG_HOST from "acme"/);
    assert.match(output, /PG_TYPO was not set/);
    assert.match(output, /secrets unset succeeded/);
  });

  test('refuses NAME=value muscle memory without quoting the value back', async () => {
    // Silently splitting on `=` would remove a secret the user did not name. The message
    // carries the name only — the text after `=` may well be a real credential.
    const { ctx, lines } = contextFor(fakeClient());

    await assert.rejects(
      () => secretsUnsetCommand(ctx, { id: 'ten_1', names: [`PG_PASSWORD=${PASSWORD}`] }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSecretArgumentError);
        assert.match(error.message, /names, not NAME=value/);
        assert.ok(!error.message.includes(PASSWORD));
        return true;
      },
    );
    assert.equal(lines.length, 0);
  });

  test('waits out a busy instance under the same key, and says so once', async () => {
    const keys: string[] = [];
    let attempts = 0;
    const client = fakeClient({
      unsetInstanceSecrets: async ({ idempotencyKey, names }) => {
        keys.push(idempotencyKey);
        attempts += 1;
        if (attempts < 3) throw new ControlPlaneError(409, 'instance_busy', 'busy');
        return {
          instance: instance(),
          operation: op({ status: 'running', kind: 'unset_secrets' }),
          secrets: names.map((name) => ({ name, removed: true })),
        };
      },
      getOperation: sequence(op({ status: 'succeeded', kind: 'unset_secrets' })),
    });
    const { ctx, lines } = contextFor(client);

    const code = await secretsUnsetCommand(ctx, { id: 'ten_1', names: ['PG_HOST'] });

    assert.equal(code, 0);
    assert.equal(new Set(keys).size, 1);
    assert.equal(lines.filter((line) => line.includes('waiting')).length, 1);
  });
});

describe('the instance is no longer a positional', () => {
  // Oracle: the shape change itself. Moving the instance off the positionals means the
  // old `secrets set <instance> NAME=value` now reads <instance> as a bare NAME — which
  // would prompt for it and set a junk secret named after the instance. A valueless
  // argument equal to the instance being acted on is that mistake, and is refused with
  // the fix. Nothing published ever had the old form, so this is a courtesy, not a
  // compatibility shim.
  test('set refuses the instance passed as a bare name, naming the fix', async () => {
    const { ctx } = contextFor(fakeClient(), {
      promptSecret: async () => 'never-reached',
    });

    await assert.rejects(
      () => secretsSetCommand(ctx, { id: 'acme', assignments: ['acme', 'PG_HOST=db'] }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSecretArgumentError);
        assert.match(error.message, /is the instance, not a secret name/);
        assert.match(error.message, /-i acme/);
        return true;
      },
    );
  });

  test('unset refuses it too, before opening an operation', async () => {
    let called = false;
    const client = fakeClient({
      unsetInstanceSecrets: async () => {
        called = true;
        throw new Error('should not have been reached');
      },
    });
    const { ctx } = contextFor(client);

    await assert.rejects(
      () => secretsUnsetCommand(ctx, { id: 'acme', names: ['acme', 'PG_HOST'] }),
      (error: unknown) => error instanceof InvalidSecretArgumentError,
    );
    assert.equal(called, false);
  });

  test('a secret genuinely named like the instance still works when given a value', async () => {
    // The guard keys on *valuelessness*, so the explicit form is untouched.
    const seen: string[][] = [];
    const client = fakeClient({
      setInstanceSecrets: async ({ values }) => {
        seen.push(Object.keys(values));
        return {
          instance: instance(),
          operation: op({ status: 'succeeded', kind: 'set_secrets' }),
          secrets: [{ name: 'acme' }],
        };
      },
    });
    const { ctx } = contextFor(client);

    assert.equal(await secretsSetCommand(ctx, { id: 'acme', assignments: ['acme=value'] }), 0);
    assert.deepEqual(seen, [['acme']]);
  });
});

describe('secrets list', () => {
  test('prints names and digests, and says so plainly when there are none', async () => {
    // Oracle: hard requirement 11's projection — names and digests are what a secret
    // operation may report. The digest is opaque; what matters is that it is shown (so a
    // rotation is visible as a changed digest) and that no field could carry a value.
    const { ctx, lines } = contextFor(fakeClient());
    const code = await secretsListCommand(ctx, { id: 'ten_1' });

    assert.equal(code, 0);
    assert.match(lines.join('\n'), /PG_HOST\s+sha256:aaa/);
    assert.match(lines.join('\n'), /PG_PASSWORD\s+sha256:bbb/);

    const empty = contextFor(
      fakeClient({ listInstanceSecrets: async () => ({ instance: instance(), secrets: [] }) }),
    );
    assert.equal(await secretsListCommand(empty.ctx, { id: 'ten_1' }), 0);
    assert.match(empty.lines.join('\n'), /no secrets set on "acme"/);
  });

  test('emits parseable JSON under --json', async () => {
    const { ctx, lines } = contextFor(fakeClient(), { json: true });
    await secretsListCommand(ctx, { id: 'ten_1' });

    const body = JSON.parse(lines.join('\n')) as { secrets: unknown };
    assert.deepEqual(body.secrets, [
      { name: 'PG_HOST', digest: 'sha256:aaa' },
      { name: 'PG_PASSWORD', digest: 'sha256:bbb' },
    ]);
  });
});

describe('parseSecretArguments', () => {
  test('splits on the first = only, so a connection string survives', async () => {
    // Oracle: reasoned by hand. Splitting on every `=` truncates a base64 key or a DSN to its
    // first segment, which surfaces much later as an unexplainable connection error.
    assert.deepEqual(parseSecretArguments(['PG_DSN=postgres://u:p@h/db?a=b&c=d']), [
      { name: 'PG_DSN', value: 'postgres://u:p@h/db?a=b&c=d' },
    ]);
  });

  test('a bare NAME carries no value', async () => {
    assert.deepEqual(parseSecretArguments(['PG_HOST=h', 'PG_PASSWORD']), [
      { name: 'PG_HOST', value: 'h' },
      { name: 'PG_PASSWORD' },
    ]);
  });

  test('names a malformed argument by position, never quoting it back', async () => {
    // What follows a leading `=` might be the credential itself, typed without its NAME.
    await assert.rejects(
      async () => parseSecretArguments([`=${PASSWORD}`]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSecretArgumentError);
        assert.match(error.message, /argument 1/);
        assert.ok(!error.message.includes(PASSWORD));
        return true;
      },
    );
  });

  test('rejects a repeated name, which JSON would silently collapse', async () => {
    await assert.rejects(async () => parseSecretArguments(['A=1', 'A=2']), /more than once/);
  });
});

describe('parseSecretLines', () => {
  test('takes values verbatim, skipping blanks, comments, and the CRLF terminator', async () => {
    // Oracle: the documented `--stdin` form — the shape a `.env` file and every secret-manager
    // export already has. A value's own trailing space is part of the value.
    const parsed = parseSecretLines(
      ['# warehouse', '', 'PG_HOST=db.example.com\r', 'PG_PASSWORD=p$a"ss ', '  PG_USER=app'].join(
        '\n',
      ),
    );

    assert.deepEqual(parsed, {
      PG_HOST: 'db.example.com',
      PG_PASSWORD: 'p$a"ss ',
      PG_USER: 'app',
    });
  });

  test('rejects a line that is not a pair, and a file with no pairs at all', async () => {
    await assert.rejects(async () => parseSecretLines('PG_HOST\n'), /line 1/);
    await assert.rejects(async () => parseSecretLines('# nothing here\n'), /no NAME=value pairs/);
  });
});
