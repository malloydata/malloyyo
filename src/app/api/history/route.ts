import { NextResponse } from "next/server";
import { eq, desc, and, isNull } from "drizzle-orm";
import { db, inquiries, toolCalls, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

export async function GET() {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  // Start from toolCalls filtered by the authenticated user, then LEFT JOIN to inquiries.
  // This is more resilient than filtering through conversations.userId, which can be stale
  // or mismatched when MCP sessions reconnect.
  const rows = await db
    .select({
      inquiryId: toolCalls.inquiryId,
      question: inquiries.question,
      createdAt: toolCalls.createdAt,
      source: toolCalls.source,
      datasetId: toolCalls.datasetId,
      malloyQuery: toolCalls.malloyInput,
      rowCount: toolCalls.rowCount,
      durationMs: toolCalls.durationMs,
      toolSeq: toolCalls.sequence,
      authorName: users.name,
    })
    .from(toolCalls)
    .leftJoin(inquiries, eq(inquiries.id, toolCalls.inquiryId))
    .leftJoin(users, eq(users.id, toolCalls.userId))
    .where(
      and(
        eq(toolCalls.userId, user.id),
        eq(toolCalls.toolName, "run_analytical_query"),
        isNull(toolCalls.error),
      )
    )
    .orderBy(desc(toolCalls.createdAt));

  // Keep the latest successful tool call per inquiry. Tool calls with no inquiry get
  // their own entry keyed by the tool call's own id (shown as orphan rows).
  const seen = new Set<string>();
  const history = rows
    .filter((row) => {
      const key = row.inquiryId ?? `tc-${row.source}-${row.createdAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);

  return NextResponse.json(history);
}
