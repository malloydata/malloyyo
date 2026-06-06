import { NextResponse } from "next/server";
import { eq, desc, and } from "drizzle-orm";
import { db, inquiries, conversations, toolCalls } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

export async function GET() {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const rows = await db
    .select({
      inquiryId: inquiries.id,
      question: inquiries.question,
      createdAt: inquiries.createdAt,
      source: toolCalls.source,
      datasetId: toolCalls.datasetId,
      malloyQuery: toolCalls.malloyInput,
      rowCount: toolCalls.rowCount,
      durationMs: toolCalls.durationMs,
      error: toolCalls.error,
      toolSeq: toolCalls.sequence,
    })
    .from(inquiries)
    .innerJoin(conversations, eq(inquiries.conversationId, conversations.id))
    .leftJoin(
      toolCalls,
      and(
        eq(toolCalls.inquiryId, inquiries.id),
        eq(toolCalls.toolName, "run_analytical_query"),
      )
    )
    .where(eq(conversations.userId, user.id))
    .orderBy(desc(inquiries.createdAt), desc(toolCalls.sequence));

  // Keep the latest tool call per inquiry (first row wins after ordering by sequence DESC).
  const seen = new Set<string>();
  const history = rows
    .filter((row) => {
      if (seen.has(row.inquiryId)) return false;
      seen.add(row.inquiryId);
      return true;
    })
    .slice(0, 100);

  return NextResponse.json(history);
}
