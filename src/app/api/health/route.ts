// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { createDeepHealthHandler } from "@/lib/deep-health";

// Readiness gate: an instance whose boot migrations failed must never answer
// 200 here. The hosted rollout gate probes this endpoint and verifies the Fly
// Machine identity before promoting it.
export const GET = createDeepHealthHandler(async () => {
  await db.execute(sql`SELECT 1`);
});
