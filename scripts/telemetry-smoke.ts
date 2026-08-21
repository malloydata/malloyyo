// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Opt-in real-provider proof through the production telemetry adapter. Use opaque,
// disposable staging IDs; this intentionally emits one ordinary allowlisted event.

export {};

if (process.env.MALLOYYO_TELEMETRY_SMOKE !== "1") {
  throw new Error("set MALLOYYO_TELEMETRY_SMOKE=1 to send the staging event");
}
if (!process.env.MALLOYYO_TENANT_ID || !process.env.MALLOYYO_ACCOUNT_ID) {
  throw new Error("MALLOYYO_TENANT_ID and MALLOYYO_ACCOUNT_ID are required");
}

async function main(): Promise<void> {
  const { captureTelemetry, shutdownTelemetry } = await import("../src/lib/telemetry");
  await captureTelemetry({
    event: "page viewed",
    properties: { page: "/other", authenticated: false },
  });
  await shutdownTelemetry();
  console.log("queued and flushed one staging telemetry event");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
