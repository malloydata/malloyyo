// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { VERSION } from "@/lib/version";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    // Surface the anonymous-access posture so monitoring can catch an instance
    // that turned it on unexpectedly.
    return NextResponse.json({ status: "ok", postgres: "ok", version: VERSION, anonymous: env.ALLOW_ANONYMOUS });
  } catch (error) {
    return NextResponse.json(
      { status: "error", postgres: "unreachable", version: VERSION, detail: String(error) },
      { status: 503 }
    );
  }
}
