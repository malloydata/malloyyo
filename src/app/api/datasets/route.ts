import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc, or } from "drizzle-orm";
import { db, datasets, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { nameToSlug } from "@/lib/slug";
import { start } from "workflow/api";
import { ingestDataset } from "@/workflows/ingest";

export const runtime = "nodejs";

const Body = z.object({
  sourceUrl: z.url(),
  name: z.string().min(1).max(64).optional(),
});

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "dataset";
    return last.replace(/\.[^.]+$/, "");
  } catch {
    return "dataset";
  }
}

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(user)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const body = Body.parse(await req.json());
  const name = nameToSlug(body.name ?? deriveNameFromUrl(body.sourceUrl));
  const id = crypto.randomUUID();
  const mdTable = `${name}_${id.slice(0, 8)}`;

  const [row] = await db
    .insert(datasets)
    .values({ id, userId: user.id, name, sourceUrl: body.sourceUrl, mdTable, status: "pending" })
    .returning();

  const run = await start(ingestDataset, [id]);
  await db.update(datasets).set({ workflowRunId: run.runId }).where(eq(datasets.id, id));

  return NextResponse.json({
    id: row.id, name: row.name, sourceUrl: row.sourceUrl, status: row.status,
    runId: run.runId, userSlug: user.slug, mcpUrl: `/mcp/${user.slug}`,
  });
}

export async function GET() {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Unauthenticated: return public datasets only (no owner info).
      const rows = await db
        .select({ id: datasets.id, name: datasets.name, sourceUrl: datasets.sourceUrl,
          status: datasets.status, rowCount: datasets.rowCount,
          createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
        .from(datasets).where(eq(datasets.isPublic, true)).orderBy(desc(datasets.createdAt)).limit(50);
      return NextResponse.json(rows);
    }
    throw err;
  }

  if (isAdmin(user)) {
    // Admins see all datasets with owner email.
    const rows = await db
      .select({
        id: datasets.id, name: datasets.name, sourceUrl: datasets.sourceUrl,
        status: datasets.status, rowCount: datasets.rowCount,
        createdAt: datasets.createdAt, readyAt: datasets.readyAt,
        isPublic: datasets.isPublic,
        ownerEmail: users.email, ownerName: users.name, ownerId: users.id,
      })
      .from(datasets)
      .leftJoin(users, eq(datasets.userId, users.id))
      .orderBy(desc(datasets.createdAt))
      .limit(50);
    return NextResponse.json(rows);
  }

  // Regular users: see public datasets only.
  const rows = await db
    .select({ id: datasets.id, name: datasets.name, sourceUrl: datasets.sourceUrl,
      status: datasets.status, rowCount: datasets.rowCount,
      createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
    .from(datasets).where(eq(datasets.isPublic, true)).orderBy(desc(datasets.createdAt)).limit(50);
  return NextResponse.json(rows);
}
