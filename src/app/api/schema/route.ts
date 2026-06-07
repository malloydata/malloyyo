import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { callTool } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function GET(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const source = new URL(req.url).searchParams.get("source");
  if (!source) return NextResponse.json({ error: "source is required" }, { status: 400 });

  const result = await callTool(user, "describe_semantic_model", { source });
  if (result.isError) return NextResponse.json({ error: result.content[0]?.text }, { status: 404 });

  return NextResponse.json(JSON.parse(result.content[0]?.text ?? "{}"));
}
