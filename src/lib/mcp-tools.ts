// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { eq, and, desc, or, count, isNull, inArray } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, conversations, inquiries, toolCalls, type User } from "@/db";
import type { SourceInfo } from "./malloy";
import { compileMalloyFiles, runMalloyFiles, describeSourceFields } from "./malloy";
import { env } from "./env";
import { parseSlug } from "./slug";
import { RUN_LABELS } from "./tool-names";

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// Every description is prefixed with this so that, when several Malloyyo
// instances are connected to the same Claude client, the tools self-identify
// and Claude can route a request to the right instance.
const TAG = `[${env.INSTANCE_NAME}]`;

// Four tools, each owning a distinct concept word so the client's relevance
// search separates them cleanly (only `query` carries "query"). Descriptions
// stay to one line — behavioral policy lives in SERVER_INSTRUCTIONS below, not
// stuffed into each tool, which is what used to dilute the search match.
export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "query",
    description:
      `${TAG} Run a Malloy query against a source and return the rows, plus a shareable link. Pass a plain-English \`question\` describing what THIS query answers — every call is recorded and shared on its own, so give each one its own question. Set execute:false to return just the generated SQL without running it. Read describe_source first so you reuse the model's existing measures and dimensions.`,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The Malloy source name to query." },
        malloy: {
          type: "string",
          description: "Malloy query starting with `run:` that references the source name.",
        },
        question: {
          type: "string",
          description: "Plain-English description of what this specific query answers. Recorded as the query's label and share text — make it describe this query, not the broader session.",
        },
        execute: {
          type: "boolean",
          description: "Default true (run and return rows). Set false to compile only and return the generated SQL.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum rows to return (default 10000). `truncated: true` in the response means more rows exist.",
        },
      },
      required: ["source", "malloy", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sources",
    description:
      `${TAG} List the Malloy sources you can query on this endpoint. Drill into one with describe_source before querying.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "describe_source",
    description:
      `${TAG} Get a source's Malloy semantic model — its measures, dimensions, views, and joins. Read this before writing a query; the model usually already defines the aggregations you need.`,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The Malloy source name to describe." },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "open_share_link",
    description:
      `${TAG} Resolve a ${env.INSTANCE_NAME} share link or slug back into its source, original question, and Malloy. Use when the user pastes a share link. Does not run the query — show it and ask how they'd like to proceed.`,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The share slug, e.g. `main_k7m2qx9p4b`, or a full /ltool/ link." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];

// Behavioral policy is sent ONCE in the MCP `initialize` result (server
// instructions) rather than repeated in every tool description — keeping the
// descriptions short is what makes them rank well in the client's tool search.
export const SERVER_INSTRUCTIONS =
  `Malloy semantic-layer analytics for ${env.INSTANCE_NAME}.\n\n` +
  `Workflow: list_sources to see what's queryable, then describe_source to read a source's measures/dimensions/views before writing Malloy. Use query to run it; set execute:false first if you want to check the generated SQL without running.\n\n` +
  `Pass a plain-English \`question\` with EVERY query, describing what that specific query answers. Each query is recorded and shared independently — don't try to group related queries; just describe each one.\n\n` +
  `After EVERY query you MUST output a "Query summary": (1) the question in plain English, (2) the Malloy logic (filters, grouping, aggregation, ordering), (3) any post-processing done outside Malloy, or "none". Omitting it is an error.\n\n` +
  `Each query response includes \`ltool_url\`. Append it to the END of the summary as a small inline markdown link, exactly like [↗](ltool_url) (or [↗ ${env.INSTANCE_NAME}](ltool_url)), so the user can open, tweak, or share the query.\n\n` +
  `Do ranking, top-N, and member selection in Malloy, not in client code.\n\n` +
  `When the user pastes a share link, call open_share_link and do not run the query until they say how to proceed.\n\n` +
  `Tools are tagged [${env.INSTANCE_NAME}] — if several instances are connected, route to the one the user means.`;

// Normalize DB sources column — legacy string[] or new {name, description?}[] format.
function normalizeSources(raw: unknown): SourceInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) =>
    typeof s === "string" ? { name: s, description: null } : { name: String(s.name), description: s.description ?? null }
  );
}

async function listAllSources(userId: string) {
  const dsList = await db
    .select({ id: datasets.id, name: datasets.name })
    .from(datasets)
    .where(and(
      or(eq(datasets.userId, userId), eq(datasets.isPublic, true)),
      eq(datasets.status, "ready"),
    ));

  const result: Array<{ source: string; model: string; description?: string | null }> = [];

  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    const sources = normalizeSources(model?.sources);
    if (sources.length === 0) {
      result.push({ source: ds.name, model: ds.name });
    } else if (sources.length === 1) {
      result.push({ source: sources[0].name, description: sources[0].description, model: ds.name });
    } else {
      for (const src of sources) {
        result.push({ source: src.name, description: src.description, model: ds.name });
      }
    }
  }
  return result;
}

async function findBySource(userId: string, sourceName: string) {
  const dsList = await db
    .select()
    .from(datasets)
    .where(and(
      or(eq(datasets.userId, userId), eq(datasets.isPublic, true)),
      eq(datasets.status, "ready"),
    ))
    .orderBy(desc(datasets.createdAt));

  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    const sources = normalizeSources(model.sources);
    const names = sources.map((s) => s.name);
    if (names.includes(sourceName) || (names.length === 0 && ds.name === sourceName) || (names.length === 1 && ds.name === sourceName)) {
      const description = sources.find((s) => s.name === sourceName)?.description ?? null;
      return { ds, model, description };
    }
  }
  return null;
}

async function latestModel(datasetId: string) {
  const [row] = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, datasetId))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);
  return row;
}

async function modelFileMap(model: { id: string; source: string }): Promise<Map<string, string>> {
  const files = await db
    .select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));
  if (files.length > 0) {
    return new Map(files.map((f) => [f.path, f.content]));
  }
  return new Map([["index.malloy", model.source]]);
}

async function nextSequence(inquiryId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(toolCalls)
    .where(eq(toolCalls.inquiryId, inquiryId));
  return Number(row?.n ?? 0);
}

async function logCall(fields: {
  inquiryId?: string;
  userId: string;
  datasetId?: string;
  toolName: string;
  source?: string;
  malloyInput?: string;
  compiledSql?: string;
  rowCount?: number;
  durationMs?: number;
  error?: string;
}) {
  const seq = fields.inquiryId ? await nextSequence(fields.inquiryId) : 0;
  await db.insert(toolCalls).values({ ...fields, sequence: seq }).catch(() => {});
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(value: unknown): ToolResult {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: s }] };
}

function errText(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// Find or create a conversation for auto-inquiry creation.
async function ensureConversation(userId: string, conversationId: string | undefined, sourceName: string, datasetId: string | undefined): Promise<string> {
  if (conversationId) return conversationId;
  const [conv] = await db
    .insert(conversations)
    .values({ userId, datasetId, source: sourceName || undefined })
    .returning({ id: conversations.id });
  return conv.id;
}

export type SharedQuery =
  | { ok: true; instance: string; source: string | null; question: string; malloy: string | null }
  | { ok: false; error: string; wrongInstance?: string };

// Resolve a share slug into the query it points at: the inquiry's question
// plus the source/Malloy from its most recent successful run. Shared by the
// open_share_link tool and the /api/ltool/share web endpoint.
export async function loadSharedQuery(slug: string): Promise<SharedQuery> {
  const parsed = parseSlug(slug);
  if (parsed && !parsed.matchesInstance) {
    return {
      ok: false,
      wrongInstance: parsed.code,
      error: `Slug '${slug}' belongs to the '${parsed.code}' Malloyyo instance, not '${env.INSTANCE_CODE}' (${env.INSTANCE_NAME}). Use that instance's tools instead.`,
    };
  }
  const [inq] = await db.select({ id: inquiries.id, question: inquiries.question }).from(inquiries).where(eq(inquiries.slug, slug)).limit(1);
  if (!inq) return { ok: false, error: `query slug '${slug}' not found` };
  const [tc] = await db
    .select({ source: toolCalls.source, malloy: toolCalls.malloyInput })
    .from(toolCalls)
    .where(and(eq(toolCalls.inquiryId, inq.id), inArray(toolCalls.toolName, RUN_LABELS), isNull(toolCalls.error)))
    .orderBy(desc(toolCalls.createdAt))
    .limit(1);
  return { ok: true, instance: env.INSTANCE_NAME, source: tc?.source ?? null, question: inq.question, malloy: tc?.malloy ?? null };
}

// Compile-only path: shared by `query` with execute:false and the legacy
// standalone compile_query tool. Logged under the "compile_query" label (which
// is no longer a registered tool, just a history label) so executed runs and
// compile checks stay distinguishable in history without a schema change.
async function compileQueryTool(user: User, inquiryId: string | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  const sourceName = String(args.source ?? args.dataset ?? "");
  const malloyQ = String(args.malloy ?? "");
  const found = await findBySource(user.id, sourceName);
  if (!found) return errText(`source '${sourceName}' not found`);
  const { ds, model } = found;
  const files = await modelFileMap(model);
  const res = await compileMalloyFiles(files, "index.malloy", malloyQ, { cacheKey: model.id });
  await logCall({
    inquiryId, userId: user.id, datasetId: ds.id, toolName: "compile_query",
    source: sourceName, malloyInput: malloyQ,
    compiledSql: res.ok ? res.sql : undefined,
    error: res.ok ? undefined : res.error,
  });
  if (!res.ok) return errText(`compile failed: ${res.error}`);
  return text({ sql: res.sql });
}

export async function callTool(
  user: User,
  name: string,
  args: Record<string, unknown>,
  opts: { origin?: string } = {},
): Promise<ToolResult> {
  const inquiryId = typeof args.inquiry_id === "string" ? args.inquiry_id : undefined;
  const baseUrl = (opts.origin ?? env.APP_BASE_URL).replace(/\/$/, "");
  const ltoolUrl = (slug: string | null) => (slug ? `${baseUrl}/ltool/${slug}` : undefined);

  switch (name) {
    case "start_conversation": {
      const sourceName = String(args.source ?? "").trim();
      const context = typeof args.context === "string" ? args.context.trim() : undefined;
      const found = sourceName ? await findBySource(user.id, sourceName) : null;
      const [conv] = await db
        .insert(conversations)
        .values({
          userId: user.id,
          datasetId: found?.ds.id,
          source: sourceName || undefined,
          context,
        })
        .returning({ id: conversations.id });
      return text({ conversation_id: conv.id });
    }

    case "start_inquiry": {
      const conversationId = String(args.conversation_id ?? "").trim();
      const question = String(args.question ?? "").trim();
      if (!conversationId) return errText("conversation_id is required");
      if (!question) return errText("question is required");
      const [seq] = await db
        .select({ n: count() })
        .from(inquiries)
        .where(eq(inquiries.conversationId, conversationId));
      const [inq] = await db
        .insert(inquiries)
        .values({ conversationId, question, sequence: Number(seq?.n ?? 0) })
        .returning({ id: inquiries.id });
      return text({ inquiry_id: inq.id });
    }

    case "list_sources":
    case "list_datasets": {
      const sources = await listAllSources(user.id);
      await logCall({ inquiryId, userId: user.id, toolName: "list_sources" });
      return text(sources);
    }

    case "open_share_link":
    case "describe_query": {
      const slug = String(args.slug ?? "").trim().replace(/^.*\/ltool\//, "");
      if (!slug) return errText("slug is required");
      const res = await loadSharedQuery(slug);
      if (!res.ok) return errText(res.error);
      return text({ instance: res.instance, source: res.source, question: res.question, malloy: res.malloy, ltool_url: ltoolUrl(slug) });
    }

    case "describe_source": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model, description } = found;
      const files = await modelFileMap(model);
      const fields = await describeSourceFields(files, "index.malloy", sourceName, { cacheKey: model.id });
      await logCall({ inquiryId, userId: user.id, datasetId: ds.id, toolName: "describe_source", source: sourceName });
      return text({ source: sourceName, model: ds.name, description, fields, malloy_source: model.source });
    }

    // Legacy standalone compile tool (no longer in the registry, still accepted).
    case "compile_query":
      return compileQueryTool(user, inquiryId, args);

    case "query":
    case "run_query": {
      // execute:false → compile only (the old compile_query behavior).
      if (args.execute === false) return compileQueryTool(user, inquiryId, args);

      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return errText("'question' is required: a plain-English description of what this query answers.");

      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const maxRows = Math.max(1, Math.min(10000, Number(args.max_rows ?? 10000)));
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      if (ds.status !== "ready") return errText(`source '${sourceName}' is not ready`);

      // Each query is its own inquiry: a fresh record + share slug per call, so
      // unrelated queries can never collapse onto one record. Claude no longer
      // threads an inquiry_id — it just labels every query with its question.
      const convId = await ensureConversation(user.id, undefined, sourceName, ds.id);
      const [inq] = await db
        .insert(inquiries)
        .values({ conversationId: convId, question, sequence: 0 })
        .returning({ id: inquiries.id, slug: inquiries.slug });

      const files = await modelFileMap(model);
      const t0 = Date.now();
      try {
        const res = await runMalloyFiles(files, "index.malloy", malloyQ, { rowLimit: maxRows, cacheKey: model.id });
        const durationMs = Date.now() - t0;
        const capped = res.rows.slice(0, maxRows);
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        await logCall({ inquiryId: inq.id, userId: user.id, datasetId: ds.id, toolName: "query", source: sourceName, malloyInput: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        const ltool = ltoolUrl(inq.slug);
        // The behavioral directive is echoed in the result (not just the server
        // instructions) because clients read the tool result every turn right
        // before summarizing — the most reliable place to make Claude append the
        // link and write the summary, while the description stays lean for ranking.
        const reminder = `End your reply with a "Query summary": (1) the question in plain English, (2) the Malloy logic (filters, grouping, aggregation, ordering), (3) post-processing outside Malloy or "none".` +
          (ltool ? ` Then append the share link as a small inline markdown link, exactly: [↗](${ltool})` : ``);
        return {
          content: [
            { type: "text", text: reminder },
            { type: "text", text: JSON.stringify({ ltool_url: ltool, row_count: res.rowCount, rows: capped, truncated: res.rowCount > capped.length, duration_ms: durationMs }, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - t0;
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, error: msg });
        await logCall({ inquiryId: inq.id, userId: user.id, datasetId: ds.id, toolName: "query", source: sourceName, malloyInput: malloyQ, error: msg, durationMs });
        return errText(`run failed: ${msg}`);
      }
    }

    default:
      return errText(`unknown tool: ${name}`);
  }
}

export type WebRunResult =
  | { ok: true; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Run a Malloy query for the web UI. Returns the full result including the
// stable (interfaces-format) result for client-side Malloy rendering.
export async function runQueryForWeb(
  userId: string,
  source: string,
  malloyQuery: string,
  maxRows = 1000,
): Promise<WebRunResult> {
  const found = await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);
  const t0 = Date.now();
  try {
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows, cacheKey: model.id });
    const capped = res.rows.slice(0, maxRows);
    return {
      ok: true,
      rows: capped,
      sql: res.sql,
      rowCount: res.rowCount,
      truncated: res.rowCount > capped.length,
      durationMs: Date.now() - t0,
      stableResult: res.stableResult,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WebSaveResult =
  | { ok: true; slug: string | null; inquiryId: string; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Run a Malloy query from the web UI AND persist it as a new history entry:
// creates a conversation + inquiry (which mints a fresh slug) and logs a
// query tool call so it shows up in /ltool history and is shareable. Used
// when the user edits a loaded query and runs it (the slug no longer matches
// the original, so it becomes a new saved query).
export async function saveWebQuery(
  userId: string,
  source: string,
  malloyQuery: string,
  title: string,
  maxRows = 1000,
): Promise<WebSaveResult> {
  const found = await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);

  const convId = await ensureConversation(userId, undefined, source, ds.id);
  const [seq] = await db.select({ n: count() }).from(inquiries).where(eq(inquiries.conversationId, convId));
  const [inq] = await db
    .insert(inquiries)
    .values({ conversationId: convId, question: title, sequence: Number(seq?.n ?? 0) })
    .returning({ id: inquiries.id, slug: inquiries.slug });

  const t0 = Date.now();
  try {
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows, cacheKey: model.id });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    await db.insert(queries).values({ datasetId: ds.id, userId, malloySource: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
    await logCall({ inquiryId: inq.id, userId, datasetId: ds.id, toolName: "query", source, malloyInput: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
    return { ok: true, slug: inq.slug, inquiryId: inq.id, rows: capped, sql: res.sql, rowCount: res.rowCount, truncated: res.rowCount > capped.length, durationMs, stableResult: res.stableResult };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await db.insert(queries).values({ datasetId: ds.id, userId, malloySource: malloyQuery, error: msg });
    await logCall({ inquiryId: inq.id, userId, datasetId: ds.id, toolName: "query", source, malloyInput: malloyQuery, error: msg, durationMs });
    return { ok: false, error: msg };
  }
}
