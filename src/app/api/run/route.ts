import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { runQueryForWeb } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  let body: { source: string; malloy: string; maxRows?: number };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { source, malloy, maxRows = 1000 } = body;
  if (!source || !malloy) {
    return NextResponse.json({ error: "source and malloy are required" }, { status: 400 });
  }

  const result = await runQueryForWeb(user.id, source, malloy, maxRows);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
