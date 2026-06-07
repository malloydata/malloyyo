import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { loadSharedQuery } from "@/lib/mcp-tools";

export const runtime = "nodejs";

// Resolve a share slug into { instance, source, question, malloy } for the
// ltool deep-link page. Requires sign-in; actually running the query is gated
// separately by /api/run (which enforces source visibility).
export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/ltool/share/[slug]">,
) {
  try { await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const { slug } = await ctx.params;
  const res = await loadSharedQuery(slug);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, wrongInstance: res.wrongInstance }, { status: 404 });
  }
  return NextResponse.json({ instance: res.instance, source: res.source, question: res.question, malloy: res.malloy });
}
