// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Integration test for the settings capability lent to an auth integration
// (src/lib/integration-settings.ts), against a real Postgres. This is a *lent*
// capability — code the application does not own calls it — so its contract
// (null means unset, null write clears, instances stay isolated) is pinned
// against the real store rather than a fake.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// pushes the schema, and runs this with DATABASE_URL pointed at it).

import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, integrationSettings } from "@/db";
import {
  readIntegrationSetting,
  writeIntegrationSetting,
} from "@/lib/integration-settings";

test("an unset key reads null", async () => {
  assert.equal(await readIntegrationSetting("never-written"), null);
});

test("write, read back, overwrite", async () => {
  await writeIntegrationSetting("session-minutes", "120");
  assert.equal(await readIntegrationSetting("session-minutes"), "120");

  await writeIntegrationSetting("session-minutes", "240");
  assert.equal(await readIntegrationSetting("session-minutes"), "240");
});

test("a null write clears the key back to unset", async () => {
  await writeIntegrationSetting("ephemeral", "x");
  await writeIntegrationSetting("ephemeral", null);
  assert.equal(await readIntegrationSetting("ephemeral"), null);

  // Clearing an already-unset key is a no-op, not an error.
  await writeIntegrationSetting("ephemeral", null);
  assert.equal(await readIntegrationSetting("ephemeral"), null);
});

test("instances sharing a database stay isolated", async () => {
  // The helpers key on this process's INSTANCE_CODE ("main" by default); a row
  // written under another instance's code must be invisible to them.
  await db
    .insert(integrationSettings)
    .values({ instanceCode: "other", key: "shared-key", value: "theirs" });
  assert.equal(await readIntegrationSetting("shared-key"), null);

  await writeIntegrationSetting("shared-key", "ours");
  assert.equal(await readIntegrationSetting("shared-key"), "ours");

  const [theirs] = await db
    .select()
    .from(integrationSettings)
    .where(eq(integrationSettings.instanceCode, "other"));
  assert.equal(theirs.value, "theirs");
});
