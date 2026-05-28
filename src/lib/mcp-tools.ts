import { eq, and, desc, or, count } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, investigations, toolCalls, type User } from "@/db";
import type { SourceInfo } from "./malloy";
import { compileMalloyFiles, runMalloyFiles, describeSourceFields } from "./malloy";

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "start_investigation",
    description:
      "Call this FIRST before any other tool. Provide a one-sentence synopsis of what you are trying to answer. Returns an investigation_id — pass it to every subsequent tool call so your work can be tracked and analyzed as a coherent thread.",
    inputSchema: {
      type: "object",
      properties: {
        synopsis: {
          type: "string",
          description: "One sentence describing the question or goal of this investigation.",
        },
      },
      required: ["synopsis"],
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
        investigation_id: { type: "string", description: "ID returned by start_investigation." },
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
        investigation_id: { type: "string", description: "ID returned by start_investigation." },
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
        investigation_id: { type: "string", description: "ID returned by start_investigation." },
      },
      required: ["source", "malloy"],
      additionalProperties: false,
    },
  },
  {
    name: "run_analytical_query",
    description:
      "Execute a Malloy query against the source and return the rows. Default row cap is 10000; pass a smaller `max_rows` if you want to bound the response. You must call describe_semantic_model first to know what measures and dimensions are available — use the pre-defined measures rather than writing raw aggregations.",
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
          description:
            "Maximum rows to return (default 10000). The result is truncated server-side at this value; `truncated: true` indicates more rows are available.",
        },
        investigation_id: { type: "string", description: "ID returned by start_investigation." },
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

// Flat list of all sources across all ready models accessible to this user.
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

// Find the dataset+model that owns a given source name.
// Falls back to matching by dataset name for old models without sources populated.
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

// Returns the file map for a model. For GitHub multi-file models returns all
// fetched files; for Claude single-file models returns {index.malloy: source}.
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

async function nextSequence(investigationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(toolCalls)
    .where(eq(toolCalls.investigationId, investigationId));
  return Number(row?.n ?? 0);
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(value: unknown): ToolResult {
  const s =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
  const investigationId = typeof args.investigation_id === "string" ? args.investigation_id : undefined;

  switch (name) {
    case "start_investigation": {
      const synopsis = String(args.synopsis ?? "").trim();
      if (!synopsis) return errText("synopsis is required");
      const [inv] = await db
        .insert(investigations)
        .values({ userId: user.id, synopsis })
        .returning({ id: investigations.id });
      return text({ investigation_id: inv.id });
    }

    case "list_sources":
    case "list_datasets": {
      const sources = await listAllSources(user.id);
      const seq = investigationId ? await nextSequence(investigationId) : 0;
      await db.insert(toolCalls).values({
        investigationId, userId: user.id, sequence: seq, toolName: "list_sources",
      }).catch(() => {});
      return text(sources);
    }

    case "describe_semantic_model": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model, description } = found;
      const files = await modelFileMap(model);
      const fields = await describeSourceFields(files, "index.malloy", sourceName);
      const seq = investigationId ? await nextSequence(investigationId) : 0;
      await db.insert(toolCalls).values({
        investigationId, userId: user.id, datasetId: ds.id, sequence: seq,
        toolName: "describe_semantic_model", source: sourceName,
      }).catch(() => {});
      return text({
        source: sourceName,
        model: ds.name,
        description,
        fields,
        malloy_source: model.source,
      });
    }

    case "compile_analytical_query": {
      const sourceName = String(args.source ?? args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const found = await findBySource(user.id, sourceName);
      if (!found) return errText(`source '${sourceName}' not found`);
      const { ds, model } = found;
      const files = await modelFileMap(model);
      const res = await compileMalloyFiles(files, "index.malloy", malloyQ);
      const seq = investigationId ? await nextSequence(investigationId) : 0;
      await db.insert(toolCalls).values({
        investigationId, userId: user.id, datasetId: ds.id, sequence: seq,
        toolName: "compile_analytical_query", source: sourceName,
        malloyInput: malloyQ,
        compiledSql: res.ok ? res.sql : undefined,
        error: res.ok ? undefined : res.error,
      }).catch(() => {});
      if (!res.ok) return errText(`compile failed: ${res.error}`);
      return text({ sql: res.sql });
    }

    case "run_analytical_query": {
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
        await db.insert(queries).values({
          datasetId: ds.id,
          userId: user.id,
          malloySource: malloyQ,
          compiledSql: res.sql,
          rowCount: res.rowCount,
          durationMs,
        });
        const seq = investigationId ? await nextSequence(investigationId) : 0;
        await db.insert(toolCalls).values({
          investigationId, userId: user.id, datasetId: ds.id, sequence: seq,
          toolName: "run_analytical_query", source: sourceName,
          malloyInput: malloyQ, compiledSql: res.sql,
          rowCount: res.rowCount, durationMs,
        }).catch(() => {});
        return text({
          row_count: res.rowCount,
          rows: capped,
          truncated: res.rowCount > capped.length,
          duration_ms: durationMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.insert(queries).values({
          datasetId: ds.id,
          userId: user.id,
          malloySource: malloyQ,
          error: msg,
        });
        const seq = investigationId ? await nextSequence(investigationId) : 0;
        await db.insert(toolCalls).values({
          investigationId, userId: user.id, datasetId: ds.id, sequence: seq,
          toolName: "run_analytical_query", source: sourceName,
          malloyInput: malloyQ, error: msg, durationMs: Date.now() - t0,
        }).catch(() => {});
        return errText(`run failed: ${msg}`);
      }
    }

    default:
      return errText(`unknown tool: ${name}`);
  }
}
