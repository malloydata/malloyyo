// The `cloud` commands. Each takes an injected control-plane client and an output sink, so
// the command logic is tested without a network, a real clock, or a process. `create`,
// `delete` and `secrets set` open an operation and poll it to a terminal status; `status`
// and `list` are reads.
import { randomUUID } from "node:crypto";
import { type ControlPlaneClient, ControlPlaneError, type Instance, type Operation } from "./api.js";

/**
 * What each provisioning step is called in the output.
 *
 * Kept here rather than sent by the server: this is presentation, and the control plane
 * should not be choosing customer-facing wording. The keys are the control plane's public
 * step vocabulary, which is a wire contract — the internal names those translate from name
 * the providers behind an instance and never leave the server. A step with no entry — one
 * the server added after this CLI shipped — is skipped rather than printed raw, because a
 * bare key tells a customer nothing useful.
 */
const STEP_LABELS: Readonly<Record<string, string>> = {
  create_sign_in: "Setting up sign-in",
  seat_administrator: "Adding you as administrator",
  register_hostname: "Authorizing your address for sign-in",
  create_database: "Creating your database",
  reserve_instance: "Reserving your instance",
  store_credentials: "Storing credentials",
  start_instance: "Starting your instance",
  start_standby: "Preparing standby capacity",
  wait_for_startup: "Waiting for it to come up",
  setup_check: "Checking it responds",
  record_success: "Finishing up",
  // The secrets roll. The standby first — it is updated while stopped, so it costs
  // nothing — then the one actually serving, which is the brief interruption.
  update_standby: "Updating standby capacity",
  update_instance: "Applying to your instance",
};

/**
 * Least-privilege: each command's token carries only the scopes it needs. `create` and
 * `delete` also carry `instances:read` because they do not stop at the mutation — they poll
 * the operation to a terminal status and re-read the instance to report its final state,
 * and the control plane gates `GET /v1/operations/{id}` and `GET /v1/instances/{id}` on
 * `instances:read`. A token missing it fails the first poll with a 403, so a bare
 * `instances:create` token cannot watch its own create.
 */
export const COMMAND_SCOPES = {
  create: ["instances:create", "instances:read"],
  status: ["instances:read"],
  list: ["instances:read"],
  delete: ["instances:delete", "instances:read"],
  // `secrets:write` is deliberately not an `instances:*` scope: it can replace the
  // credentials a tenant queries its own warehouse with, which is well outside the blast
  // radius the instance-management scopes are bounded to. `instances:read` comes along for
  // the same reason `create` carries it — this command polls the operation it opens and
  // re-reads the instance, and the control plane gates both GETs on read.
  "secrets set": ["secrets:write", "instances:read"],
  // Removal is a write to the same configuration, so it is the same scope — there is
  // still no read scope, and nothing here for one to read.
  "secrets unset": ["secrets:write", "instances:read"],
  // Listing serves names and digests, which the write scope already learns from every
  // set and unset response — there is no value anywhere on this path to gate. No
  // `instances:read`: nothing is polled and nothing re-read.
  "secrets list": ["secrets:write"],
} as const;

export interface CommandContext {
  readonly client: ControlPlaneClient;
  readonly out: (line: string) => void;
  /** Emit machine-readable JSON instead of human text. */
  readonly json: boolean;
  // Test seams; all default to real behavior.
  readonly newIdempotencyKey?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly maxOperationWaitMs?: number;
  /** How `secrets set` waits out another operation on the same instance. */
  readonly busyPollIntervalMs?: number;
  readonly maxBusyWaitMs?: number;
  /**
   * Reads all of stdin, for `secrets set --stdin`. Injected rather than read here so the
   * command stays free of `process`.
   */
  readonly readStdin?: () => Promise<string>;
  /**
   * Prompts for one secret's value on the terminal with the input hidden, for a bare `NAME`
   * argument. Absent when there is no terminal, which is what makes "prompt or tell them to
   * use --stdin" decidable here.
   */
  readonly promptSecret?: (name: string) => Promise<string>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
// Provisioning builds real infrastructure and can take minutes; this only bounds how long
// the CLI blocks, not the operation itself, which keeps running server-side.
const DEFAULT_MAX_OPERATION_WAIT_MS = 10 * 60 * 1_000;

function instanceUrl(instance: Instance): string | null {
  return instance.hostname === null ? null : `https://${instance.hostname}`;
}

function printInstance(ctx: CommandContext, instance: Instance): void {
  const url = instanceUrl(instance);
  ctx.out(`  ${instance.slug}  (${instance.id})`);
  ctx.out(`    lifecycle: ${instance.lifecycle}`);
  if (url !== null) ctx.out(`    url:       ${url}`);
}

/** `4m 12s`, for saying how long we actually waited rather than how long we meant to. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

/** The operation as last seen, and how long we watched it before returning. */
interface WaitResult {
  readonly operation: Operation;
  readonly waitedMs: number;
}

async function waitForOperation(ctx: CommandContext, operation: Operation): Promise<WaitResult> {
  const sleep = ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = ctx.now ?? Date.now;
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWait = ctx.maxOperationWaitMs ?? DEFAULT_MAX_OPERATION_WAIT_MS;
  // A real deadline, not a count of intervals: each poll is a network round trip, so
  // summing the sleeps alone would make a slow control plane block for several times the
  // bound the caller asked for.
  const startedAt = now();
  const deadline = startedAt + maxWait;

  // Steps already reported, so each is printed once however many times we poll.
  const reported = new Set<string>();
  const report = (current: Operation): void => {
    // Silent in --json: that output is parsed, and progress lines would corrupt it.
    if (ctx.json) return;
    for (const step of current.steps ?? []) {
      if (reported.has(step.key)) continue;
      reported.add(step.key);
      const label = STEP_LABELS[step.key];
      if (label !== undefined) ctx.out(`  ✓ ${label}`);
    }
  };

  let current = operation;
  report(current);
  while (current.status === "running") {
    if (now() >= deadline) {
      // One last read before giving up. The loop sleeps between polls, so without this the
      // reported status can be a whole interval stale — and the status that landed during
      // that final sleep is exactly the one the caller was waiting for.
      current = await ctx.client.getOperation(current.id);
      report(current);
      break;
    }
    await sleep(interval);
    current = await ctx.client.getOperation(current.id);
    report(current);
  }
  return { operation: current, waitedMs: now() - startedAt };
}

/**
 * Reports an operation's terminal outcome and returns the process exit code. On success it
 * re-reads the instance so the printed state is what the server now holds.
 *
 * A null `operation` is the control plane's documented answer for an instance already in a
 * terminal delete state that no operation row explains. There is nothing to poll, and the
 * delete the caller asked for is already true, so this reports the instance and succeeds.
 * This is precisely the retry path a delete's Idempotency-Key exists for, so it must not be
 * the path that fails.
 */
async function reportOperation(
  ctx: CommandContext,
  operation: Operation | null,
  instanceId: string,
  verb: string,
): Promise<number> {
  if (operation === null) {
    const instance = await ctx.client.getInstance(instanceId);
    if (ctx.json) {
      ctx.out(JSON.stringify({ operation: null, instance }, null, 2));
    } else {
      ctx.out(`${verb} succeeded: the instance was already ${instance.lifecycle}.`);
      printInstance(ctx, instance);
    }
    return 0;
  }

  const { operation: final, waitedMs } = await waitForOperation(ctx, operation);

  if (final.status === "succeeded") {
    const instance = await ctx.client.getInstance(instanceId);
    if (ctx.json) {
      ctx.out(JSON.stringify({ operation: final, instance }, null, 2));
    } else {
      ctx.out(`${verb} succeeded:`);
      printInstance(ctx, instance);
      // The way in. A create that ends without telling someone where to sign in leaves them
      // holding an instance ID and no next move.
      const url = instanceUrl(instance);
      if (verb === "create" && url !== null) {
        ctx.out("");
        // The block, then the commands — in that order, because the commands do not
        // work without it. `malloy-config.json` is the author's file: nothing in this
        // toolchain writes it (the MCP author guide says so explicitly), so the honest
        // next step is to show exactly what to add rather than to print a command that
        // fails on a missing target.
        ctx.out("Add this to malloy-config.json in your model repo:");
        ctx.out("");
        ctx.out(`  "malloyyo": {`);
        ctx.out(`    "targets": {`);
        ctx.out(`      "${instance.slug}": { "url": "${url}", "dataset": "<dataset>" }`);
        ctx.out(`    }`);
        ctx.out(`  }`);
        ctx.out("");
        ctx.out(`Sign in at ${url}`);
        ctx.out(`Then, from that repo:  malloyyo login && malloyyo publish`);
      }
    }
    return 0;
  }

  if (final.status === "failed") {
    if (ctx.json) {
      ctx.out(JSON.stringify({ operation: final }, null, 2));
    } else {
      ctx.out(`${verb} failed: ${final.error ?? "unknown error"}`);
    }
    return 1;
  }

  // The CLI stopped waiting; the operation did not. Say that, rather than "still in
  // progress" — which reads as a report on the instance when it is really a report on us.
  //
  // The distinction is not pedantic. On 2026-08-12 a create was failing the whole time the
  // CLI watched it, the CLI gave up nineteen seconds before the failure was recorded, and
  // the last thing it printed was that the create was progressing. Nothing said the wait
  // had a limit or that it had been reached.
  if (ctx.json) {
    ctx.out(JSON.stringify({ operation: final }, null, 2));
  } else {
    ctx.out(
      `Stopped waiting after ${formatDuration(waitedMs)} — this is the CLI giving up, not ` +
        `the ${verb} failing.`,
    );
    ctx.out(
      `The ${verb} is still running server-side (operation ${final.id}). Check it with ` +
        "`malloyyo cloud instance status`.",
    );
  }
  return 0;
}

export async function createCommand(ctx: CommandContext, args: { slug: string }): Promise<number> {
  const idempotencyKey = (ctx.newIdempotencyKey ?? randomUUID)();
  const { instance, operation } = await ctx.client.createInstance({
    slug: args.slug,
    idempotencyKey,
  });
  if (!ctx.json) ctx.out(`creating instance "${args.slug}" (operation ${operation.id})…`);
  return reportOperation(ctx, operation, instance.id, "create");
}

/** How the CLI waits out another operation, rather than making the user retry by hand. */
const DEFAULT_BUSY_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BUSY_WAIT_MS = 5 * 60 * 1_000;

export class InvalidSecretArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecretArgumentError";
  }
}

/**
 * One `NAME=value` or bare `NAME` argument. A bare name means the value is not on the
 * command line at all and must be prompted for.
 */
export interface SecretArgument {
  readonly name: string;
  /** Absent for a bare `NAME`: the value has to come from somewhere safer. */
  readonly value?: string;
}

/**
 * The secret arguments, without resolving any value.
 *
 * A `NAME=value` splits on the *first* `=` only: a connection string or a base64 key
 * contains more, and splitting on all of them would silently truncate a credential to its
 * first segment — the kind of failure that surfaces as an unexplainable connection error
 * much later. A bare `NAME` carries no value, which is the whole point of it.
 *
 * What a name may actually be is the control plane's rule, not this parser's; duplicating
 * it here would put the reserved-name list in two places that must agree. Only what the
 * server cannot see is checked: a repeated name, which a JSON object would silently
 * collapse to whichever came last before the request ever left.
 */
export function parseSecretArguments(args: readonly string[]): readonly SecretArgument[] {
  if (args.length === 0) {
    throw new InvalidSecretArgumentError("give at least one NAME or NAME=value");
  }
  const parsed: SecretArgument[] = [];
  const seen = new Set<string>();
  for (const [index, argument] of args.entries()) {
    const separator = argument.indexOf("=");
    if (separator === 0) {
      // Everything after the `=` may well be the credential, so the argument is identified
      // by position and never quoted back — this message reaches terminals, shell history,
      // and CI logs.
      throw new InvalidSecretArgumentError(`argument ${index + 1} has no name before its "="`);
    }
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (name === "") throw new InvalidSecretArgumentError(`argument ${index + 1} is empty`);
    if (seen.has(name)) throw new InvalidSecretArgumentError(`"${name}" was given more than once`);
    seen.add(name);
    parsed.push(separator === -1 ? { name } : { name, value: argument.slice(separator + 1) });
  }
  return parsed;
}

/**
 * `NAME=value` lines from stdin, the way `--stdin` takes them.
 *
 * Blank lines and `#` comments are skipped so a `.env` file pipes in directly. Values are
 * taken verbatim — no unquoting, no escape processing, no variable expansion: a password
 * containing `"` or `$` is a password, and a parser that interpreted either would corrupt
 * it in a way nobody could debug from the outside.
 */
export function parseSecretLines(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [index, rawLine] of text.split("\n").entries()) {
    // Only the line terminator is removed — the `\r` of a CRLF file, which the format put
    // there. Nothing else is stripped from the right-hand side: a value's trailing space may
    // be part of the credential, and silently dropping it produces an authentication failure
    // with no visible cause anywhere. Whitespace the user did not intend is a worse error
    // message; whitespace the user did intend is an unfindable one.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new InvalidSecretArgumentError(`line ${index + 1} is not a NAME=value pair`);
    }
    // The name is trimmed, so an indented or aligned file still parses. A name cannot
    // contain whitespace anyway — the control plane rejects one that does.
    const name = line.slice(0, separator).trim();
    if (name in values) {
      throw new InvalidSecretArgumentError(`"${name}" appears on more than one line`);
    }
    values[name] = line.slice(separator + 1);
  }
  if (Object.keys(values).length === 0) {
    throw new InvalidSecretArgumentError("stdin carried no NAME=value pairs");
  }
  return values;
}

function isInstanceBusy(error: unknown): boolean {
  return error instanceof ControlPlaneError && error.code === "instance_busy";
}

/**
 * Where each secret's value comes from.
 *
 * A value typed as `NAME=value` is written to the shell's history file and is visible in
 * `ps` to every other process on the machine for as long as the command runs. For a
 * warehouse password that is not an acceptable default, so there are two ways not to do it,
 * covering the two situations that actually occur:
 *
 *   - `--stdin` takes `NAME=value` lines on stdin, for a file, a CI variable, or a password
 *     manager (`op read … | malloyyo cloud secrets set … --stdin`).
 *   - a bare `NAME` argument prompts for that one value on the terminal with the input
 *     hidden — the interactive case, which `--stdin` alone does not fix, because
 *     `echo 'PG_PASSWORD=…' | …` puts the value straight back in the history file.
 *
 * `NAME=value` stays, because a host, a port, and a user are not secrets and typing them is
 * the ergonomic path. Mixing is the intended shape:
 *
 *     malloyyo cloud secrets set <id> PG_HOST=db.example.com PG_USER=app PG_PASSWORD
 */
/**
 * Catches the one shape the instance moving off the positionals broke: `secrets set
 * <instance> NAME=value`, which now reads `<instance>` as a bare NAME to prompt for and
 * would set a junk secret named after the instance. A *valueless* argument equal to the
 * instance being acted on is that mistake with near-certainty — anyone genuinely wanting
 * a secret of that name would write `name=value` — so it is refused with the fix rather
 * than prompted for.
 */
function rejectInstanceAsSecretName(
  id: string,
  parsed: ReadonlyArray<{ name: string; value?: string }>,
): void {
  const looksLikeTheInstance = parsed.some(
    (argument) => argument.value === undefined && argument.name === id,
  );
  if (looksLikeTheInstance) {
    throw new InvalidSecretArgumentError(
      `"${id}" is the instance, not a secret name — it is no longer a positional argument.\n` +
        `Run this inside the model repo that publishes to it, or pass it as -i ${id}.`,
    );
  }
}

async function resolveSecretValues(
  ctx: CommandContext,
  args: { id: string; assignments: readonly string[]; stdin?: boolean },
): Promise<Readonly<Record<string, string>>> {
  if (args.stdin === true) {
    if (args.assignments.length > 0) {
      // Silently preferring one source would make it unclear which value was actually
      // sent — the worst possible ambiguity for this command.
      throw new InvalidSecretArgumentError("--stdin takes the pairs on stdin, not as arguments");
    }
    if (ctx.readStdin === undefined) {
      throw new InvalidSecretArgumentError("--stdin is not available here");
    }
    return parseSecretLines(await ctx.readStdin());
  }

  const parsed = parseSecretArguments(args.assignments);
  rejectInstanceAsSecretName(args.id, parsed);
  const values: Record<string, string> = {};
  for (const argument of parsed) {
    if (argument.value !== undefined) {
      values[argument.name] = argument.value;
      continue;
    }
    if (ctx.promptSecret === undefined) {
      throw new InvalidSecretArgumentError(
        `no value given for "${argument.name}", and there is no terminal to prompt on; ` +
          "pass it with --stdin instead",
      );
    }
    const value = await ctx.promptSecret(argument.name);
    if (value === "") {
      throw new InvalidSecretArgumentError(`no value entered for "${argument.name}"`);
    }
    values[argument.name] = value;
  }
  return values;
}

/**
 * Sets warehouse secrets on an instance and waits until they are live.
 *
 * Two things make this the verb it is meant to be. It waits out a concurrent operation
 * instead of surfacing a 409 — a bare conflict would expose exactly the orchestration this
 * command exists to hide — retrying under the *same* Idempotency-Key, which is safe because
 * a busy answer means no operation was opened. And it does not return until the roll
 * finishes, so when the command exits 0 the secret is live and the customer can test their
 * connection.
 */
export async function secretsSetCommand(
  ctx: CommandContext,
  args: { id: string; assignments: readonly string[]; stdin?: boolean },
): Promise<number> {
  const values = await resolveSecretValues(ctx, args);
  const names = Object.keys(values);
  const idempotencyKey = (ctx.newIdempotencyKey ?? randomUUID)();
  const sleep = ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = ctx.now ?? Date.now;
  const deadline = now() + (ctx.maxBusyWaitMs ?? DEFAULT_MAX_BUSY_WAIT_MS);

  let result: Awaited<ReturnType<ControlPlaneClient["setInstanceSecrets"]>>;
  let announcedWait = false;
  for (;;) {
    try {
      result = await ctx.client.setInstanceSecrets({ id: args.id, values, idempotencyKey });
      break;
    } catch (error) {
      if (!isInstanceBusy(error) || now() >= deadline) throw error;
      if (!ctx.json && !announcedWait) {
        // Once, not per attempt: a line every five seconds reads as thrashing.
        ctx.out("another operation is running on this instance, waiting…");
        announcedWait = true;
      }
    }
    // The wait sits after the catch, not inside it: awaited work on an error path can throw
    // over the error already in flight, and here that would replace the conflict being
    // waited on with whatever the timer did. Same shape as the retry in api.ts.
    await sleep(ctx.busyPollIntervalMs ?? DEFAULT_BUSY_POLL_INTERVAL_MS);
  }

  if (!ctx.json) {
    // Names only. The values are in this process's memory and in the instance host's secret
    // store, and nowhere else — least of all in a terminal scrollback.
    ctx.out(`setting ${names.join(", ")} on "${result.instance.slug}"…`);
  }
  return reportOperation(ctx, result.operation, result.instance.id, "secrets set");
}

/**
 * A name handed to `secrets unset`. The likely slip is the muscle memory of `set`:
 * `secrets unset PG_HOST=x` — refused by name, because silently splitting on `=` would
 * remove a secret the user did not say to remove.
 */
function parseUnsetNames(raw: readonly string[]): readonly string[] {
  if (raw.length === 0) {
    throw new InvalidSecretArgumentError("give at least one secret name to unset");
  }
  const seen = new Set<string>();
  for (const name of raw) {
    if (name.includes("=")) {
      throw new InvalidSecretArgumentError(
        `unset takes names, not NAME=value pairs (got "${name.slice(0, name.indexOf("="))}=…")`,
      );
    }
    if (seen.has(name)) {
      throw new InvalidSecretArgumentError(`"${name}" appears more than once`);
    }
    seen.add(name);
  }
  return raw;
}

/**
 * Removes warehouse secrets from an instance and waits until the change is live.
 *
 * The same two commitments as `secrets set`, for the same reasons: it waits out a
 * concurrent operation under one Idempotency-Key instead of surfacing a 409, and it does
 * not return until the roll finishes — exit 0 means the values are out of the instance,
 * not merely scheduled to be. A name that was never set is reported as such and is not an
 * error: the state the user asked for is the state they have.
 */
export async function secretsUnsetCommand(
  ctx: CommandContext,
  args: { id: string; names: readonly string[] },
): Promise<number> {
  const names = parseUnsetNames(args.names);
  // Same muscle-memory guard as `set`. Here the mistake is merely noisy rather than
  // harmful — an instance name reads back as "was not set" — but the fix is the same
  // sentence, so it may as well be said before the roll rather than after it.
  rejectInstanceAsSecretName(
    args.id,
    names.map((name) => ({ name })),
  );
  const idempotencyKey = (ctx.newIdempotencyKey ?? randomUUID)();
  const sleep = ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = ctx.now ?? Date.now;
  const deadline = now() + (ctx.maxBusyWaitMs ?? DEFAULT_MAX_BUSY_WAIT_MS);

  let result: Awaited<ReturnType<ControlPlaneClient["unsetInstanceSecrets"]>>;
  let announcedWait = false;
  for (;;) {
    try {
      result = await ctx.client.unsetInstanceSecrets({ id: args.id, names, idempotencyKey });
      break;
    } catch (error) {
      if (!isInstanceBusy(error) || now() >= deadline) throw error;
      if (!ctx.json && !announcedWait) {
        ctx.out("another operation is running on this instance, waiting…");
        announcedWait = true;
      }
    }
    // Same shape as `secrets set`: the wait sits after the catch so the timer can never
    // throw over the conflict being waited on.
    await sleep(ctx.busyPollIntervalMs ?? DEFAULT_BUSY_POLL_INTERVAL_MS);
  }

  if (!ctx.json) {
    const wasRemoved = result.secrets.filter((secret) => secret.removed).map((s) => s.name);
    const wasAbsent = result.secrets.filter((secret) => !secret.removed).map((s) => s.name);
    if (wasRemoved.length > 0) {
      ctx.out(`removing ${wasRemoved.join(", ")} from "${result.instance.slug}"…`);
    }
    for (const name of wasAbsent) {
      ctx.out(`  ${name} was not set`);
    }
  }
  return reportOperation(ctx, result.operation, result.instance.id, "secrets unset");
}

/**
 * Lists an instance's secrets: names and digests, never values — the control plane has
 * no endpoint that could return one. The digest answers "did this value change since I
 * set it"; the names answer what `set` and `unset` may act on, which is exactly the set
 * shown (the platform's own reserved names are filtered server-side).
 */
export async function secretsListCommand(ctx: CommandContext, args: { id: string }): Promise<number> {
  const { instance, secrets } = await ctx.client.listInstanceSecrets(args.id);
  if (ctx.json) {
    ctx.out(JSON.stringify({ instance, secrets }, null, 2));
    return 0;
  }
  if (secrets.length === 0) {
    ctx.out(`no secrets set on "${instance.slug}".`);
    return 0;
  }
  const width = Math.max(...secrets.map((secret) => secret.name.length));
  for (const secret of secrets) {
    ctx.out(`  ${secret.name.padEnd(width)}  ${secret.digest ?? ""}`.trimEnd());
  }
  return 0;
}

export async function statusCommand(ctx: CommandContext, args: { id: string }): Promise<number> {
  const instance = await ctx.client.getInstance(args.id);
  if (ctx.json) {
    ctx.out(JSON.stringify(instance, null, 2));
  } else {
    printInstance(ctx, instance);
  }
  return 0;
}

export async function listCommand(ctx: CommandContext): Promise<number> {
  const instances = await ctx.client.listInstances();
  if (ctx.json) {
    ctx.out(JSON.stringify(instances, null, 2));
    return 0;
  }
  if (instances.length === 0) {
    ctx.out("no instances.");
    return 0;
  }
  ctx.out(`${instances.length} instance${instances.length === 1 ? "" : "s"}:`);
  for (const instance of instances) printInstance(ctx, instance);
  return 0;
}

export async function deleteCommand(ctx: CommandContext, args: { id: string }): Promise<number> {
  const idempotencyKey = (ctx.newIdempotencyKey ?? randomUUID)();
  const { instance, operation } = await ctx.client.deleteInstance({
    id: args.id,
    idempotencyKey,
  });
  if (!ctx.json && operation !== null) {
    ctx.out(`deleting instance "${instance.slug}" (operation ${operation.id})…`);
  }
  return reportOperation(ctx, operation, instance.id, "delete");
}
