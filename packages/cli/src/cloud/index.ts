// `malloyyo cloud …` — managing Malloyyo-hosted instances.
//
// This module is the only part of the command group that touches the process: it wires
// commander to `runCloud`, supplies stdin and the hidden prompt, and sets the exit code.
// Everything that decides anything lives in `./run.js` and `./commands.js`, which take
// their inputs as arguments.
import { resolve } from "node:path";
import type { Command } from "commander";
import { inferInstance, InstanceInferenceError } from "./infer.js";
import { type CloudInvocation, runCloud } from "./run.js";

/**
 * Everything on stdin, for `secrets set --stdin`.
 *
 * Hand-rolled deliberately, unlike the prompt below: an async iteration over a stream is a
 * standard-library one-liner with no terminal state, no signal handling, and nothing to get
 * subtly wrong.
 */
async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * Reads one secret from the terminal without echoing it.
 *
 * A library, not our own raw-mode loop. Reading a password off a TTY is not the small
 * function it looks like: it means owning echo suppression, backspace and DEL, Ctrl-C and
 * Ctrl-D, stream end and error, and restoring terminal state on every exit path including
 * the ones that throw. A hand-written version of exactly this shipped two bugs immediately —
 * a `case` that could never match, and a missing end handler that hung the command when
 * stdin closed without a newline.
 *
 * Input is hidden entirely rather than masked with `*`: a row of asterisks puts the
 * credential's *length* in the scrollback, which this command has no reason to leak. The
 * prompt is written to stderr, so `--json` stays a clean parseable document on stdout even
 * when a value was prompted for.
 *
 * Imported lazily so `malloyyo publish` does not pay for a prompt library it never uses.
 */
async function promptSecret(name: string): Promise<string> {
  const { default: password } = await import("@inquirer/password");
  try {
    return await password({ message: `Value for ${name} (hidden):` }, { output: process.stderr });
  } catch (error) {
    // Ctrl-C and Ctrl-D both arrive here. Rethrown with wording that says what the user did,
    // rather than the library's own "force closed the prompt".
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new Error(`entering ${name} was cancelled`);
    }
    throw error;
  }
}

/**
 * The instance a verb should act on: the one given, or the one the working directory's
 * malloy-config.json points at — the same context `login` and `publish` resolve, guarded
 * to Malloyyo-hosted targets only (see ./infer.ts for the self-hosted hazard).
 *
 * Inferred context is never silent: the announcement goes to stderr so `--json` output
 * stays a clean parseable document either way. Returns null after printing the failure,
 * so callers exit 2 — the same "never reached the control plane" meaning every other
 * usage error carries. `instance delete` must not call this, permanently: an implicit
 * default on a destructive verb is where cleverness is least welcome.
 */
function resolveOrInferInstance(given: string | undefined): string | null {
  if (given !== undefined) return given;
  try {
    const inferred = inferInstance(resolve("."));
    process.stderr.write(
      `using instance ${inferred.slug} (from malloy-config.json target "${inferred.targetName}")\n`,
    );
    return inferred.slug;
  } catch (error) {
    if (error instanceof InstanceInferenceError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return null;
    }
    throw error;
  }
}

/**
 * Runs one invocation and sets the exit code.
 *
 * `process.exitCode` rather than `process.exit`, so buffered stdout is flushed before the
 * process ends — a `--json` document truncated mid-write is worse than a slow exit.
 */
async function dispatch(invocation: CloudInvocation, json: boolean): Promise<void> {
  process.exitCode = await runCloud(invocation, {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    json,
    readStdin,
    // Only when there is a terminal to prompt on. Its absence is what lets a bare `NAME`
    // under a pipe fail with "use --stdin" instead of hanging forever on input that is never
    // coming.
    ...(process.stdin.isTTY === true ? { promptSecret } : {}),
  });
}

const SECRETS_SET_HELP = `Secrets are the values your Malloy models resolve warehouse connections from, as
{ "env": "NAME" } in malloy-config.json. Several in one command are applied together.
The command returns once they are live; your instance restarts briefly. Values are
stored only by the instance host and are never readable back through this CLI.

Run inside your model repo and the instance is the one its malloy-config.json
publishes to; -i names a different one explicitly.

A value typed as NAME=value goes into your shell history and is visible to other
processes while the command runs. Two ways to avoid that:

  malloyyo cloud secrets set PG_HOST=db.example.com PG_USER=app PG_PASSWORD
      a bare NAME is prompted for, with the input hidden

  op read op://vault/pg/password | malloyyo cloud secrets set --stdin
      --stdin reads NAME=value lines: a file, a CI variable, a password manager`;

/** Adds the `cloud` command group to the CLI. */
export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command("cloud")
    .description("manage Malloyyo-hosted instances")
    .addHelpText(
      "after",
      "\nCredentials come from MALLOYYO_CLIENT_ID and MALLOYYO_CLIENT_SECRET.\n",
    );

  const instance = cloud.command("instance").description("create and manage hosted instances");

  instance
    .command("create")
    .argument("<slug>", "the name your instance is reached at: <slug>.malloyyo.com")
    .option("--json", "print the result as JSON instead of progress lines")
    .description("provision a new hosted instance and wait for it to come up")
    .action(async (slug: string, opts: { json?: boolean }) => {
      await dispatch({ command: "create", slug }, opts.json === true);
    });

  instance
    .command("status")
    .argument("[instance]", "instance name (the one in its URL) or ID; inferred from malloy-config.json when omitted")
    .option("--json", "print the instance as JSON")
    .description("show an instance's lifecycle, URL, and observed state")
    .action(async (instance: string | undefined, opts: { json?: boolean }) => {
      const id = resolveOrInferInstance(instance);
      if (id === null) return;
      await dispatch({ command: "status", id }, opts.json === true);
    });

  instance
    .command("list")
    .option("--json", "print the instances as JSON")
    .description("list your hosted instances")
    .action(async (opts: { json?: boolean }) => {
      await dispatch({ command: "list" }, opts.json === true);
    });

  instance
    .command("delete")
    .argument("<instance>", "instance name (the one in its URL) or ID")
    .option("--json", "print the result as JSON instead of progress lines")
    .description("delete an instance (reversible until it is destroyed)")
    .action(async (instance: string, opts: { json?: boolean }) => {
      await dispatch({ command: "delete", id: instance }, opts.json === true);
    });

  const secrets = cloud.command("secrets").description("manage an instance's warehouse secrets");

  // The secrets verbs never take the instance positionally: their positionals are
  // names, which no grammar can reliably tell apart from an instance slug
  // (`secrets unset token` — a name, or an instance?). The instance is the working
  // directory's — the same context `login` and `publish` resolve — with `-i` as the
  // explicit override. This is flyctl's and Heroku's shape for exactly this reason.
  const instanceOption = [
    "-i, --instance <instance>",
    "instance name (the one in its URL) or ID; otherwise inferred from malloy-config.json",
  ] as const;

  secrets
    .command("set")
    .argument("[assignments...]", "NAME=value pairs, or a bare NAME to be prompted for")
    .option(...instanceOption)
    .option("--stdin", "read NAME=value lines from stdin instead of the command line")
    .option("--json", "print the result as JSON instead of progress lines")
    .description("set warehouse secrets on an instance and wait until they are live")
    .addHelpText("after", `\n${SECRETS_SET_HELP}\n`)
    .action(
      async (
        assignments: string[],
        opts: { instance?: string; stdin?: boolean; json?: boolean },
      ) => {
        const id = resolveOrInferInstance(opts.instance);
        if (id === null) return;
        await dispatch(
          { command: "secrets set", id, assignments, stdin: opts.stdin === true },
          opts.json === true,
        );
      },
    );

  secrets
    .command("unset")
    .argument("<names...>", "secret names to remove — names only, no values")
    .option(...instanceOption)
    .option("--json", "print the result as JSON instead of progress lines")
    .description("remove warehouse secrets from an instance and wait until the change is live")
    .action(async (names: string[], opts: { instance?: string; json?: boolean }) => {
      const id = resolveOrInferInstance(opts.instance);
      if (id === null) return;
      await dispatch({ command: "secrets unset", id, names }, opts.json === true);
    });

  secrets
    .command("list")
    .option(...instanceOption)
    .option("--json", "print names and digests as JSON")
    .description("list the secrets set on an instance — names and digests, never values")
    .action(async (opts: { instance?: string; json?: boolean }) => {
      const id = resolveOrInferInstance(opts.instance);
      if (id === null) return;
      await dispatch({ command: "secrets list", id }, opts.json === true);
    });
}
