// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { TelemetryEvent } from "./telemetry";

process.env.DATABASE_URL ??= "postgres://telemetry-test.invalid/malloyyo";

let telemetry: typeof import("./telemetry");

// Compile-time contract: event-specific objects cannot smuggle query content through
// the provider boundary. `tsc` fails if this expected rejection ever disappears.
const forbiddenFieldProof: TelemetryEvent = {
  event: "query ran",
  properties: {
    entrypoint: "mcp",
    outcome: "success",
    duration_ms: 1,
    author_kind: "assistant",
    client_family: "claude",
    // @ts-expect-error query text is intentionally outside the telemetry allowlist
    query_text: "run: secret",
  },
};
void forbiddenFieldProof;

before(async () => {
  telemetry = await import("./telemetry");
});

test("uses the configured PostHog US Cloud ingestion host", () => {
  // Exact contract pin: the Malloyyo PostHog project's Region setting is US Cloud.
  assert.equal(telemetry.POSTHOG_HOST, "https://us.i.posthog.com");
});

test("self-hosted telemetry defaults on and honors disable/debug", () => {
  assert.deepEqual(telemetry.telemetryConfiguration({}), {
    hosted: false,
    enabled: true,
    debug: false,
    tenantId: "",
    accountId: "",
  });
  assert.equal(telemetry.telemetryConfiguration({ MALLOYYO_TELEMETRY_DISABLED: "1" }).enabled, false);
  assert.equal(telemetry.telemetryConfiguration({ MALLOYYO_TELEMETRY_DEBUG: "1" }).debug, true);
});

test("hosted identity wins over self-hosted suppression switches", () => {
  assert.deepEqual(
    telemetry.telemetryConfiguration({
      MALLOYYO_TENANT_ID: "ten_hosted",
      MALLOYYO_ACCOUNT_ID: "acct_parent",
      MALLOYYO_TELEMETRY_DISABLED: "1",
      MALLOYYO_TELEMETRY_DEBUG: "1",
    }),
    {
      hosted: true,
      enabled: true,
      debug: false,
      tenantId: "ten_hosted",
      accountId: "acct_parent",
    },
  );
});

test("anonymous hosted capture needs no tenant database identity lookup", async () => {
  let loaded = false;
  const messages: unknown[] = [];
  await telemetry.captureTelemetry(
    { event: "page viewed", properties: { page: "/", authenticated: false } },
    null,
    {
      configuration: {
        hosted: true,
        enabled: true,
        debug: false,
        tenantId: "ten_hosted",
        accountId: "acct_parent",
      },
      loadTelemetryId: async () => {
        loaded = true;
        return "unused";
      },
      client: { capture: (message) => messages.push(message) },
    },
  );
  assert.equal(loaded, false);
  assert.equal(messages.length, 1);
});

test("actor pseudonyms are stable per instance and never contain the raw user id", () => {
  const first = telemetry.pseudonymousActorId("instance-a", "user-secret");
  assert.equal(first, telemetry.pseudonymousActorId("instance-a", "user-secret"));
  assert.notEqual(first, telemetry.pseudonymousActorId("instance-b", "user-secret"));
  assert.doesNotMatch(first, /user-secret/);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("page paths discard query strings and dynamic customer-controlled values", () => {
  assert.equal(telemetry.normalizePagePath("/datasets/8af/dashboard/revenue?region=secret"), "/datasets/:id/dashboard/:name");
  assert.equal(telemetry.normalizePagePath("/ltool/main_k7m2qx9p4b"), "/ltool/:slug");
  assert.equal(telemetry.normalizePagePath("/datasets/8af/questions"), "/datasets/:id/questions");
  assert.equal(telemetry.normalizePagePath("/an-unknown/customer/path"), "/other");
});

test("history telemetry counts executed query outcomes once and excludes validation", () => {
  assert.deepEqual(
    telemetry.historyTelemetryEvent({
      entrypoint: "mcp",
      toolName: "query",
      executed: true,
      durationMs: 42,
      authorModel: "claude-opus",
      userAgent: "Claude/1.0",
    }),
    {
      event: "query ran",
      properties: {
        entrypoint: "mcp",
        outcome: "success",
        duration_ms: 42,
        author_kind: "assistant",
        client_family: "claude",
      },
    },
  );
  assert.equal(
    telemetry.historyTelemetryEvent({ entrypoint: "mcp", toolName: "query", executed: false }),
    null,
  );
  for (const entrypoint of ["mcp", "ltool", "dashboard"] as const) {
    assert.deepEqual(
      telemetry.historyTelemetryEvent({
        entrypoint,
        toolName: "query",
        executed: true,
        error: "failed",
      }),
      {
        event: "query ran",
        properties: {
          entrypoint,
          outcome: "error",
          duration_ms: 0,
          author_kind: "assistant",
          client_family: "other",
        },
      },
    );
  }
  assert.deepEqual(
    telemetry.historyTelemetryEvent({ entrypoint: "mcp", toolName: "describe_source", error: "bad" }),
    {
      event: "mcp tool called",
      properties: { tool: "describe_source", outcome: "error" },
    },
  );
});

test("capture sends only the typed event plus common anonymous dimensions", async () => {
  const messages: unknown[] = [];
  await telemetry.captureTelemetry(
    {
      event: "query ran",
      properties: {
        entrypoint: "ltool",
        outcome: "success",
        duration_ms: 12,
        author_kind: "human",
        client_family: "browser",
      },
    },
    "raw-user-id",
    {
      configuration: {
        hosted: true,
        enabled: true,
        debug: false,
        tenantId: "ten_123",
        accountId: "acct_456",
      },
      loadTelemetryId: async () => "installation-salt",
      client: { capture: (message) => messages.push(message) },
    },
  );

  assert.equal(messages.length, 1);
  const encoded = JSON.stringify(messages[0]);
  assert.doesNotMatch(encoded, /raw-user-id/);
  assert.match(encoded, /ten_123/);
  assert.match(encoded, /acct_456/);
  assert.doesNotMatch(encoded, /question|malloy|sql|dataset_name|email|hostname/);
});

test("disabled capture does no identity lookup or delivery, while debug only prints", async () => {
  let loaded = false;
  let delivered = false;
  const event = { event: "dataset removed", properties: {} } as const;
  await telemetry.captureTelemetry(event, null, {
    configuration: { hosted: false, enabled: false, debug: false, tenantId: "", accountId: "" },
    loadTelemetryId: async () => {
      loaded = true;
      return "unused";
    },
    client: { capture: () => { delivered = true; } },
  });
  assert.equal(loaded, false);
  assert.equal(delivered, false);

  const debug: Record<string, unknown>[] = [];
  await telemetry.captureTelemetry(event, null, {
    configuration: { hosted: false, enabled: true, debug: true, tenantId: "", accountId: "" },
    loadTelemetryId: async () => "self-hosted-id",
    client: { capture: () => { delivered = true; } },
    writeDebug: (payload) => debug.push(payload),
  });
  assert.equal(debug.length, 1);
  assert.equal(delivered, false);
});
