import { eq, and, desc, or, count } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, conversations, inquiries, toolCalls, type User } from "@/db";
import type { SourceInfo } from "./malloy";
import { compileMalloyFiles, runMalloyFiles, describeSourceFields } from "./malloy";

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "start_conversation",
    description:
      "Call this ONCE at the beginning of a session, before any other tool. Provide the name of the source you will explore and a brief description of what the user is trying to accomplish overall. Returns a conversation_id to pass to run_analytical_query.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The Malloy source name you will be querying." },
        context: { type: "string", description: "One sentence describing the user's overall goal for this session." },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sources",
    description:
      "List all queryable Malloy sources available on this MCP endpoint. Each source is a named entity you can run analytical queries against. Multiple sources may come from the same semantic model. After listing, call describe_semantic_model on the source you want to query.",
    inputSchema: {
      type: "object",
      properties: {
        inquiry_id: { type: "string", description: "Optional inquiry_id from a previous run_analytical_query call." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_semantic_model",
    description:
      "Return the full Malloy semantic model for the named source: all pre-defined measures, dimensions, views, and joins. Always call this before writing any query — the model almost certainly already has the measures you need (counts, sums, averages) so you do not need to write aggregations from scratch. Reading the model once is cheaper than iterating through compile errors.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        inquiry_id: { type: "string", description: "Optional inquiry_id from a previous run_analytical_query call." },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "compile_analytical_query",
    description:
      "Compile a Malloy query against the source's semantic model and return the generated SQL, without executing. Use this to validate syntax cheaply. You must call describe_semantic_model first to know what measures and dimensions are available.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        malloy: {
          type: "string",
          description: "Malloy query starting with `run:` that references the source name.",
        },
        inquiry_id: { type: "string", description: "Optional inquiry_id from a previous run_analytical_query call." },
      },
      required: ["source", "malloy"],
      additionalProperties: false,
    },
  },
  {
    name: "run_analytical_query",
    description:
      "Execute a Malloy query against the source and return the rows. You must call describe_semantic_model first.\n\nInquiry tracking (required — exactly one of these):\n- `question`: Pass the user's question in plain English to start a NEW inquiry. The response will include an `inquiry_id`.\n- `inquiry_id`: Pass the `inquiry_id` from a previous call to continue the same inquiry (follow-up queries, refinements, retries).\n\nAfter EVERY call you MUST output a 'Query summary': (1) question in plain English, (2) Malloy logic (filters, grouping, aggregation, ordering), (3) post-processing outside Malloy or 'none'. Omitting this summary is an error.\n\nVisualization rule: filtering top-N, ranking, and member selection must happen in Malloy — not in client code.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        malloy: {
          type: "string",
          description: "Malloy query starting with `run:` that references the source name.",
        },
        question: {
          type: "string",
          description: "The user's question in plain English. Provide this to start a new inquiry. Omit when continuing an existing inquiry (use inquiry_id instead).",
        },
        inquiry_id: {
          type: "string",
          description: "ID from a previous run_analytical_query response. Provide this to continue an existing inquiry. Omit when asking a new question (use question instead).",
        },
        conversation_id: {
          type: "string",
          description: "Optional. ID from start_conversation. If omitted a conversation is created automatically.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum rows to return (default 10000). Truncated server-side; `truncated: true` means more rows exist.",
        },
      },
      required: ["source", "malloy"],
      additionalProperties: false,
    },
  },
];

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

export async function callTool(
  user: User,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const inquiryId = typeof args.inquiry_id === "string" ? args.inquiry_id : undefined;

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

    case "describe_semantic_model": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model, description } = found;
      const files = await modelFileMap(model);
      const fields = await describeSourceFields(files, "index.malloy", sourceName);
      await logCall({ inquiryId, userId: user.id, datasetId: ds.id, toolName: "describe_semantic_model", source: sourceName });
      return text({ source: sourceName, model: ds.name, description, fields, malloy_source: model.source });
    }

    case "compile_analytical_query": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      const files = await modelFileMap(model);
      const res = await compileMalloyFiles(files, "index.malloy", malloyQ);
      await logCall({
        inquiryId, userId: user.id, datasetId: ds.id, toolName: "compile_analytical_query",
        source: sourceName, malloyInput: malloyQ,
        compiledSql: res.ok ? res.sql : undefined,
        error: res.ok ? undefined : res.error,
      });
      if (!res.ok) return errText(`compile failed: ${res.error}`);
      return text({ sql: res.sql });
    }

    case "run_analytical_query": {
      const question = typeof args.question === "string" ? args.question.trim() : undefined;
      const conversationId = typeof args.conversation_id === "string" ? args.conversation_id : undefined;

      // Resolve or create the inquiry.
      let resolvedInquiryId = inquiryId;
      if (!resolvedInquiryId) {
        if (!question) return errText("Provide either 'question' (new inquiry) or 'inquiry_id' (follow-up).");
        const sourceName0 = String(args.source ?? "").trim();
        const found0 = await findBySource(user.id, sourceName0);
        const convId = await ensureConversation(user.id, conversationId, sourceName0, found0?.ds.id);
        const [seq] = await db.select({ n: count() }).from(inquiries).where(eq(inquiries.conversationId, convId));
        const [inq] = await db
          .insert(inquiries)
          .values({ conversationId: convId, question, sequence: Number(seq?.n ?? 0) })
          .returning({ id: inquiries.id });
        resolvedInquiryId = inq.id;
      }

      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const maxRows = Math.max(1, Math.min(10000, Number(args.max_rows ?? 10000)));
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      if (ds.status !== "ready") return errText(`source '${sourceName}' is not ready`);
      const files = await modelFileMap(model);
      const t0 = Date.now();
      try {
        const res = await runMalloyFiles(files, "index.malloy", malloyQ, { rowLimit: maxRows });
        const durationMs = Date.now() - t0;
        const capped = res.rows.slice(0, maxRows);
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        await logCall({ inquiryId: resolvedInquiryId, userId: user.id, datasetId: ds.id, toolName: "run_analytical_query", source: sourceName, malloyInput: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        return text({ inquiry_id: resolvedInquiryId, row_count: res.rowCount, rows: capped, truncated: res.rowCount > capped.length, duration_ms: durationMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - t0;
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, error: msg });
        await logCall({ inquiryId: resolvedInquiryId, userId: user.id, datasetId: ds.id, toolName: "run_analytical_query", source: sourceName, malloyInput: malloyQ, error: msg, durationMs });
        return errText(`run failed: ${msg}\n\ninquiry_id: ${resolvedInquiryId}`);
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
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows });
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
