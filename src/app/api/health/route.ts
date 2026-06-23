// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { VERSION } from "@/lib/version";

export async function GET() {
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
