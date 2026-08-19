// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { VERSION } from "@/lib/version";
import { migrationGateError } from "@/lib/migration-state";

export async function GET() {
  // Readiness gate: an instance whose boot migrations failed must never answer
  // 200 here — the hosted roll gate probes this endpoint on a new image before
  // promoting it, and a one-click deploy's first health check is this too.
  const gate = migrationGateError();
  if (gate) {
    return NextResponse.json(
      { status: "error", migrations: "failed", version: VERSION, detail: gate },
      { status: 503 }
    );
  }
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ status: "ok", postgres: "ok", version: VERSION });
  } catch (error) {
    return NextResponse.json(
      { status: "error", postgres: "unreachable", version: VERSION, detail: String(error) },
      { status: 503 }
    );
  }
}
