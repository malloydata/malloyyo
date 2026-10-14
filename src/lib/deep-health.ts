// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { migrationGateError } from "@/lib/migration-state";
import { VERSION } from "@/lib/version";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type PostgresHealthCheck = () => Promise<unknown>;

function runtimeIdentity(environment: RuntimeEnvironment) {
  const flyMachineId = environment.FLY_MACHINE_ID?.trim();
  return flyMachineId ? { runtime: { flyMachineId } } : {};
}

/**
 * Build the deep-health handler around the database boundary so its complete HTTP
 * contract can be tested without connecting to a database.
 *
 * Fly injects FLY_MACHINE_ID into each Machine. Returning it lets an external rollout
 * controller prove that a routed 200 came from the exact Machine being promoted rather
 * than from the still-live spare. Non-Fly deployments keep their existing response.
 */
export function createDeepHealthHandler(
  checkPostgres: PostgresHealthCheck,
  environment: RuntimeEnvironment = process.env,
) {
  const identity = runtimeIdentity(environment);

  return async function deepHealth(): Promise<Response> {
    const gate = migrationGateError();
    if (gate) {
      return Response.json(
        { status: "error", migrations: "failed", version: VERSION, detail: gate, ...identity },
        { status: 503 },
      );
    }

    try {
      await checkPostgres();
      return Response.json({ status: "ok", postgres: "ok", version: VERSION, ...identity });
    } catch (error) {
      return Response.json(
        {
          status: "error",
          postgres: "unreachable",
          version: VERSION,
          detail: String(error),
          ...identity,
        },
        { status: 503 },
      );
    }
  };
}
