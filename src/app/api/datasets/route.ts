import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc, ne, and } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { nameToSlug } from "@/lib/slug";
import { start } from "workflow/api";
import { ingestDataset, modelExistingTable } from "@/workflows/ingest";
import { GitHubURLReader, parseGitHubRepo } from "@/lib/github";
import { introspectModelWithReader } from "@/lib/malloy";

export const runtime = "nodejs";

const IngestBody = z.object({
  sourceUrl: z.url(),
  name: z.string().min(1).max(64).optional(),
});

const TableBody = z.object({
  mdTable: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
});

const GitHubBody = z.object({
  githubRepo: z.string().min(1),
  githubBranch: z.string().min(1).default("main"),
  name: z.string().min(1).max(64),
  useToken: z.boolean().default(true),
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

  const raw = await req.json();

  // Existing table path: { mdTable, name }
  if (raw && typeof raw === "object" && "mdTable" in raw) {
    const body = TableBody.parse(raw);
    const name = nameToSlug(body.name);
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(datasets)
      .values({ id, userId: user.id, name, sourceUrl: `motherduck://${body.mdTable}`, mdTable: body.mdTable, status: "pending" })
      .returning();
    const run = await start(modelExistingTable, [id]);
    await db.update(datasets).set({ workflowRunId: run.runId }).where(eq(datasets.id, id));
    return NextResponse.json({ id: row.id, name, status: row.status, runId: run.runId });
  }

  // GitHub path: { githubRepo, githubBranch, name }
  if (raw && typeof raw === "object" && "githubRepo" in raw) {
    const body = GitHubBody.parse(raw);
    const name = nameToSlug(body.name);
    const { owner, repo } = parseGitHubRepo(body.githubRepo);
    const branch = body.githubBranch;

    const id = crypto.randomUUID();
    const [row] = await db
      .insert(datasets)
      .values({
        id,
        userId: user.id,
        name,
        sourceUrl: `https://github.com/${body.githubRepo}/tree/${branch}`,
        mdTable: "",
        githubRepo: body.githubRepo,
        githubBranch: branch,
        githubUseToken: body.useToken,
        status: "modeling",
      })
      .returning();

    const reader = new GitHubURLReader(owner, repo, branch, body.useToken);
    const result = await introspectModelWithReader(reader, "index.malloy");

    if (!result.ok) {
      await db.update(datasets).set({ status: "failed", statusError: result.error }).where(eq(datasets.id, id));
      return NextResponse.json({ id: row.id, error: result.error, status: "failed" }, { status: 422 });
    }

    const indexContent = reader.fetched.get("index.malloy") ?? "";
    const [model] = await db
      .insert(malloyModels)
      .values({
        datasetId: id,
        version: 1,
        source: indexContent,
        generatedBy: `github:${body.githubRepo}@${branch}`,
        compiledAt: new Date(),
        sources: result.sources,
      })
      .returning();

    if (reader.fetched.size > 0) {
      await db.insert(malloyModelFiles).values(
        Array.from(reader.fetched.entries()).map(([path, content]) => ({
          modelId: model.id,
          path,
          content,
        })),
      );
    }

    await db.update(datasets).set({ status: "ready", readyAt: new Date() }).where(eq(datasets.id, id));
    return NextResponse.json({ id: row.id, name, status: "ready", sources: result.sources });
  }

  // Ingest path: { sourceUrl, name? }
  const body = IngestBody.parse(raw);
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
    runId: run.runId, userSlug: user.slug,
  });
}

export async function GET() {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) {
      const rows = await db
        .select({ id: datasets.id, name: datasets.name, sourceUrl: datasets.sourceUrl,
          status: datasets.status, rowCount: datasets.rowCount,
          createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
        .from(datasets).where(and(eq(datasets.isPublic, true), ne(datasets.status, "failed"))).orderBy(desc(datasets.createdAt)).limit(50);
      return NextResponse.json(rows);
    }
    throw err;
  }

  if (isAdmin(user)) {
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
      .where(ne(datasets.status, "failed"))
      .orderBy(desc(datasets.createdAt))
      .limit(50);
    return NextResponse.json(rows);
  }

  const rows = await db
    .select({ id: datasets.id, name: datasets.name, sourceUrl: datasets.sourceUrl,
      status: datasets.status, rowCount: datasets.rowCount,
      createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
    .from(datasets).where(and(eq(datasets.isPublic, true), ne(datasets.status, "failed"))).orderBy(desc(datasets.createdAt)).limit(50);
  return NextResponse.json(rows);
}
