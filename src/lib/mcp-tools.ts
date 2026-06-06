import { eq, and, desc, or, count } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, conversations, inquiries, toolCalls, type User } from "@/db";
import type { SourceInfo } from "./malloy";
import { compileMalloyFiles, runMalloyFiles, describeSourceFields } from "./malloy";

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// Shared inquiry params appended to every substantive tool.
const INQUIRY_PARAMS = {
  question: {
    type: "string",
    description: "The user's question in their words. Pass this on the FIRST call for a new question — it creates an inquiry and returns inquiry_id. Omit on follow-up calls for the same question.",
  },
  inquiry_id: {
    type: "string",
    description: "inquiry_id returned by a previous call. Pass this on follow-up calls to associate them with the same inquiry.",
  },
};

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "list_sources",
    description:
      "List all queryable Malloy sources available on this MCP endpoint. Each source is a named entity you can run analytical queries against. Call describe_semantic_model on the source you want to query before writing any query.",
    inputSchema: {
      type: "object",
      properties: { ...INQUIRY_PARAMS },
      additionalProperties: false,
    },
  },
  {
    name: "describe_semantic_model",
    description:
      "Return the full Malloy semantic model for the named source: all pre-defined measures, dimensions, views, and joins. Always call this before writing any query — the model almost certainly already has the measures you need (counts, sums, averages) so you do not need to write aggregations from scratch. Pass 'question' to start tracking this inquiry; the returned inquiry_id threads all subsequent calls.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        ...INQUIRY_PARAMS,
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "compile_analytical_query",
    description:
      "Compile a Malloy query against the source's semantic model and return the generated SQL, without executing. Use this to validate syntax cheaply. Call describe_semantic_model first to know what measures and dimensions are available.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        malloy: {
          type: "string",
          description: "Malloy query starting with `run:` that references the source name.",
        },
        ...INQUIRY_PARAMS,
      },
      required: ["source", "malloy"],
      additionalProperties: false,
    },
  },
  {
    name: "run_analytical_query",
    description:
      "Execute a Malloy query against the source and return the rows. Default row cap is 10000; pass a smaller `max_rows` to bound the response. Call describe_semantic_model first to know what measures and dimensions are available — use pre-defined measures rather than writing raw aggregations. Pass 'question' to start tracking this inquiry; the returned inquiry_id threads all subsequent calls.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        malloy: {
          type: "string",
          description: "Malloy query starting with `run:` that references the source name.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum rows to return (default 10000). `truncated: true` means more rows are available.",
        },
        ...INQUIRY_PARAMS,
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

// Create a conversation + inquiry when question is provided; return existing inquiry_id otherwise.
async function ensureInquiry(
  userId: string,
  question?: string,
  inquiryId?: string,
  datasetId?: string,
  source?: string,
): Promise<string | undefined> {
  if (inquiryId) return inquiryId;
  if (!question) return undefined;
  const [conv] = await db
    .insert(conversations)
    .values({ userId, datasetId, source })
    .returning({ id: conversations.id });
  const [inq] = await db
    .insert(inquiries)
    .values({ conversationId: conv.id, question, sequence: 0 })
    .returning({ id: inquiries.id });
  return inq.id;
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

export async function callTool(
  user: User,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const question = typeof args.question === "string" ? args.question.trim() : undefined;
  const inquiryId = typeof args.inquiry_id === "string" ? args.inquiry_id : undefined;

  switch (name) {
    // Legacy — kept for backwards compatibility with existing MCP clients.
    case "start_conversation": {
      const sourceName = String(args.source ?? "").trim();
      const context = typeof args.context === "string" ? args.context.trim() : undefined;
      const found = sourceName ? await findBySource(user.id, sourceName) : null;
      const [conv] = await db
        .insert(conversations)
        .values({ userId: user.id, datasetId: found?.ds.id, source: sourceName || undefined, context })
        .returning({ id: conversations.id });
      return text({ conversation_id: conv.id });
    }

    case "start_inquiry": {
      const conversationId = String(args.conversation_id ?? "").trim();
      const q = String(args.question ?? "").trim();
      if (!conversationId) return errText("conversation_id is required");
      if (!q) return errText("question is required");
      const [seq] = await db.select({ n: count() }).from(inquiries).where(eq(inquiries.conversationId, conversationId));
      const [inq] = await db
        .insert(inquiries)
        .values({ conversationId, question: q, sequence: Number(seq?.n ?? 0) })
        .returning({ id: inquiries.id });
      return text({ inquiry_id: inq.id });
    }

    case "list_sources":
    case "list_datasets": {
      const inqId = await ensureInquiry(user.id, question, inquiryId);
      const sources = await listAllSources(user.id);
      await logCall({ inquiryId: inqId, userId: user.id, toolName: "list_sources" });
      return text(inqId ? { sources, inquiry_id: inqId } : sources);
    }

    case "describe_semantic_model": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model, description } = found;
      const inqId = await ensureInquiry(user.id, question, inquiryId, ds.id, sourceName);
      const files = await modelFileMap(model);
      const fields = await describeSourceFields(files, "index.malloy", sourceName);
      await logCall({ inquiryId: inqId, userId: user.id, datasetId: ds.id, toolName: "describe_semantic_model", source: sourceName });
      return text({ source: sourceName, model: ds.name, description, fields, malloy_source: model.source, inquiry_id: inqId });
    }

    case "compile_analytical_query": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      const inqId = await ensureInquiry(user.id, question, inquiryId, ds.id, sourceName);
      const files = await modelFileMap(model);
      const res = await compileMalloyFiles(files, "index.malloy", malloyQ);
      await logCall({
        inquiryId: inqId, userId: user.id, datasetId: ds.id, toolName: "compile_analytical_query",
        source: sourceName, malloyInput: malloyQ,
        compiledSql: res.ok ? res.sql : undefined,
        error: res.ok ? undefined : res.error,
      });
      if (!res.ok) return errText(`compile failed: ${res.error}`);
      return text({ sql: res.sql, inquiry_id: inqId });
    }

    case "run_analytical_query": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const maxRows = Math.max(1, Math.min(10000, Number(args.max_rows ?? 10000)));
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      if (ds.status !== "ready") return errText(`source '${sourceName}' is not ready`);
      const inqId = await ensureInquiry(user.id, question, inquiryId, ds.id, sourceName);
      const files = await modelFileMap(model);
      const t0 = Date.now();
      try {
        const res = await runMalloyFiles(files, "index.malloy", malloyQ, { rowLimit: maxRows });
        const durationMs = Date.now() - t0;
        const capped = res.rows.slice(0, maxRows);
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        await logCall({ inquiryId: inqId, userId: user.id, datasetId: ds.id, toolName: "run_analytical_query", source: sourceName, malloyInput: malloyQ, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
        return text({ row_count: res.rowCount, rows: capped, truncated: res.rowCount > capped.length, duration_ms: durationMs, inquiry_id: inqId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - t0;
        await db.insert(queries).values({ datasetId: ds.id, userId: user.id, malloySource: malloyQ, error: msg });
        await logCall({ inquiryId: inqId, userId: user.id, datasetId: ds.id, toolName: "run_analytical_query", source: sourceName, malloyInput: malloyQ, error: msg, durationMs });
        return errText(`run failed: ${msg}`);
      }
    }

    default:
      return errText(`unknown tool: ${name}`);
  }
}
