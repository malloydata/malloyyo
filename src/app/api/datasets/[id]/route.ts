import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets, malloyModels, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id));
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Public datasets visible to all; private only to admins and owners.
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) {
      if (!ds.isPublic) return NextResponse.json({ error: "not found" }, { status: 404 });
      me = null;
    } else throw err;
  }

  if (me && !ds.isPublic && !isAdmin(me) && ds.userId !== me.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, ds.userId));
  const [model] = await db.select().from(malloyModels)
    .where(eq(malloyModels.datasetId, id)).limit(1);

  return NextResponse.json({
    id: ds.id, name: ds.name, sourceUrl: ds.sourceUrl,
    mdTable: ds.mdTable, rowCount: ds.rowCount, status: ds.status,
    statusError: ds.statusError, workflowRunId: ds.workflowRunId,
    createdAt: ds.createdAt, readyAt: ds.readyAt,
    isPublic: ds.isPublic,
    schema: ds.schemaJson, sampleRows: ds.sampleRowsJson,
    userSlug: user?.slug ?? null,
    isAdmin: me ? isAdmin(me) : false,
    malloyModel: model
      ? { source: model.source, generatedBy: model.generatedBy, compiledAt: model.compiledAt }
      : null,
  });
}

export async function PATCH(
  req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const { isPublic } = await req.json() as { isPublic: boolean };
  const [updated] = await db.update(datasets).set({ isPublic }).where(eq(datasets.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id: updated.id, isPublic: updated.isPublic });
}
