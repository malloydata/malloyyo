import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ status: "ok", postgres: "ok" });
  } catch (error) {
    return NextResponse.json(
      { status: "error", postgres: "unreachable", detail: String(error) },
      { status: 503 }
    );
  }
}
