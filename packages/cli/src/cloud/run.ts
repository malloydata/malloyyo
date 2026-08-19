// Dispatch for `malloyyo cloud`, as a pure-ish function: it takes the environment, output
// sinks, and an optional client factory, so config errors, routing, and every failure path
// are testable without a process, a network, or real auth.
//
// Ported from the standalone CLI this command group replaces. What was left behind is that
// CLI's shell: its `util.parseArgs` handling and its usage text are commander's job here,
// and only the part after parsing came across. What was kept is the contract that made it
// testable — no `process`, and it never throws: every failure leaves as an exit code,
// because a rejection at the top level is an unhandled rejection and a raw stack trace for
// what is usually a mistyped environment variable.
import { type ControlPlaneClient, ControlPlaneError, createControlPlaneClient } from "./api.js";
import {
  COMMAND_SCOPES,
  type CommandContext,
  createCommand,
  deleteCommand,
  InvalidSecretArgumentError,
  listCommand,
  secretsListCommand,
  secretsSetCommand,
  secretsUnsetCommand,
  statusCommand,
} from "./commands.js";
import { type CloudConfig, loadCloudConfig, MissingCloudConfigError } from "./config.js";
import { createCloudTokenSource } from "./token-source.js";

/** The commands, keyed the same way as the scope table so the two cannot disagree. */
export type CloudCommand = keyof typeof COMMAND_SCOPES;

export type CloudInvocation =
  | { readonly command: "create"; readonly slug: string }
  | { readonly command: "status"; readonly id: string }
  | { readonly command: "list" }
  | { readonly command: "delete"; readonly id: string }
  | {
      readonly command: "secrets set";
      readonly id: string;
      readonly assignments: readonly string[];
      readonly stdin: boolean;
    }
  | {
      readonly command: "secrets unset";
      readonly id: string;
      readonly names: readonly string[];
    }
  | { readonly command: "secrets list"; readonly id: string };

type ClientFactory = (config: CloudConfig, scopes: readonly string[]) => ControlPlaneClient;

export interface RunCloudDeps {
  readonly env: Record<string, string | undefined>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Emit machine-readable JSON instead of human text. */
  readonly json?: boolean;
  /** Overridable so tests skip the credential exchange and the network. */
  readonly makeClient?: ClientFactory;
  /** Reads all of stdin, for `secrets set --stdin`. */
  readonly readStdin?: () => Promise<string>;
  /**
   * Prompts for one secret with the input hidden. Supplied only when stdin is a terminal,
   * so its absence means "there is nothing to prompt on".
   */
  readonly promptSecret?: (name: string) => Promise<string>;
}

/** The real client: a scoped M2M token source feeding the control-plane HTTP client. */
function defaultClientFactory(config: CloudConfig, scopes: readonly string[]): ControlPlaneClient {
  const tokenSource = createCloudTokenSource(config, scopes);
  return createControlPlaneClient({
    apiUrl: config.apiUrl,
    getAccessToken: () => tokenSource.getAccessToken(),
  });
}

export async function runCloud(
  invocation: CloudInvocation,
  deps: RunCloudDeps,
): Promise<number> {
  let config: CloudConfig;
  try {
    config = loadCloudConfig(deps.env);
  } catch (error) {
    if (error instanceof MissingCloudConfigError) {
      deps.err(error.message);
      return 2;
    }
    throw error;
  }

  const makeClient = deps.makeClient ?? defaultClientFactory;

  // Building the client is not expected to throw now that config is three plain strings,
  // but this function's whole contract is that it returns an exit code: a rejection here is
  // an unhandled rejection and a raw stack trace for what would be a configuration problem.
  // The guard costs nothing and keeps that contract true by construction.
  let ctx: CommandContext;
  try {
    ctx = {
      client: makeClient(config, COMMAND_SCOPES[invocation.command]),
      out: deps.out,
      json: deps.json === true,
      // `promptSecret` is absent when stdin is not a terminal, and that absence is what
      // turns a bare NAME under a pipe into a clear "use --stdin" error instead of a
      // command that hangs on input that is never coming.
      ...(deps.readStdin === undefined ? {} : { readStdin: deps.readStdin }),
      ...(deps.promptSecret === undefined ? {} : { promptSecret: deps.promptSecret }),
    };
  } catch (error) {
    deps.err(
      `could not build a control-plane client from the environment: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 2;
  }

  try {
    switch (invocation.command) {
      case "create":
        return await createCommand(ctx, { slug: invocation.slug });
      case "status":
        return await statusCommand(ctx, { id: invocation.id });
      case "list":
        return await listCommand(ctx);
      case "delete":
        return await deleteCommand(ctx, { id: invocation.id });
      case "secrets set":
        return await secretsSetCommand(ctx, {
          id: invocation.id,
          assignments: invocation.assignments,
          stdin: invocation.stdin,
        });
      case "secrets unset":
        return await secretsUnsetCommand(ctx, { id: invocation.id, names: invocation.names });
      case "secrets list":
        return await secretsListCommand(ctx, { id: invocation.id });
    }
  } catch (error) {
    if (error instanceof InvalidSecretArgumentError) {
      // A usage error like a missing argument, so it exits 2 with the same meaning — the
      // command never reached the control plane.
      deps.err(error.message);
      return 2;
    }
    if (error instanceof ControlPlaneError) {
      // The control plane already phrased this for a caller; pass it through with the status.
      deps.err(`error (${error.status}): ${error.message}`);
      return 1;
    }
    deps.err(error instanceof Error ? error.message : "an unexpected error occurred");
    return 1;
  }
}
