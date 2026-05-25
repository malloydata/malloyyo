import { eq, and, desc, or } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, type User } from "@/db";
import { compileMalloy, runMalloy, compileMalloyFiles, runMalloyFiles } from "./malloy";
import { sampleTable } from "./duckdb";

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "list_datasets",
    description:
      "List all datasets available to this MCP endpoint. Returns each dataset's name, status, source URL, and row schema summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_semantic_model",
    description:
      "Return the Malloy semantic model (source declarations, measures, dimensions) for the named dataset. Use this first to learn what queries are possible.",
    inputSchema: {
      type: "object",
      properties: { dataset: { type: "string" } },
      required: ["dataset"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_rows",
    description:
      "Return up to N (default 20, max 200) raw sample rows from the dataset's underlying Parquet. Useful for quickly inspecting values before writing a Malloy query.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
  },
  {
    name: "compile_analytical_query",
    description:
      "Compile a Malloy query against the dataset's semantic model and return the generated SQL, without executing. Use this to validate syntax cheaply.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        malloy: {
          type: "string",
          description:
            "Malloy query starting with `run:` that references the dataset's source.",
        },
      },
      required: ["dataset", "malloy"],
      additionalProperties: false,
    },
  },
  {
    name: "run_analytical_query",
    description:
      "Execute a Malloy query against the dataset and return the rows. Default row cap is 10000; pass a smaller `max_rows` if you want to bound the response.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        malloy: {
          type: "string",
          description:
            "Malloy query starting with `run:` that references the dataset's source.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description:
            "Maximum rows to return (default 10000). The result is truncated server-side at this value; `truncated: true` indicates more rows are available.",
        },
      },
      required: ["dataset", "malloy"],
      additionalProperties: false,
    },
  },
];

async function listUserDatasets(userId: string) {
  return db
    .select({
      id: datasets.id,
      name: datasets.name,
      status: datasets.status,
      sourceUrl: datasets.sourceUrl,
      rowCount: datasets.rowCount,
      schemaJson: datasets.schemaJson,
      readyAt: datasets.readyAt,
    })
    .from(datasets)
    .where(or(eq(datasets.userId, userId), eq(datasets.isPublic, true)));
}

async function findDataset(userId: string, name: string) {
  // Prefer the latest 'ready' dataset for this name; fall back to the
  // latest of any status (so failure messages are informative).
  const rows = await db
    .select()
    .from(datasets)
    .where(and(or(eq(datasets.userId, userId), eq(datasets.isPublic, true)), eq(datasets.name, name)))
    .orderBy(desc(datasets.createdAt));
  return rows.find((r) => r.status === "ready") ?? rows[0];
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
  switch (name) {
    case "list_datasets": {
      const rows = await listUserDatasets(user.id);
      return text(
        rows.map((r) => ({
          name: r.name,
          status: r.status,
          source_url: r.sourceUrl,
          row_count: r.rowCount,
          column_count: Array.isArray(r.schemaJson) ? r.schemaJson.length : null,
          ready_at: r.readyAt,
        })),
      );
    }
    case "describe_semantic_model": {
      const dsName = String(args.dataset ?? "");
      const ds = await findDataset(user.id, dsName);
      if (!ds) return errText(`dataset '${dsName}' not found`);
      if (ds.status !== "ready") return errText(`dataset '${dsName}' is ${ds.status}, not ready`);
      const model = await latestModel(ds.id);
      if (!model) return errText(`dataset '${dsName}' has no Malloy model`);
      return text({
        name: ds.name,
        column_count: Array.isArray(ds.schemaJson) ? ds.schemaJson.length : 0,
        schema: ds.schemaJson,
        sources: model.sources ?? null,
        malloy_source: model.source,
      });
    }
    case "sample_rows": {
      const dsName = String(args.dataset ?? "");
      const n = Math.max(1, Math.min(200, Number(args.n ?? 20)));
      const ds = await findDataset(user.id, dsName);
      if (!ds) return errText(`dataset '${dsName}' not found`);
      if (ds.status !== "ready") return errText(`dataset '${dsName}' is ${ds.status}, not ready`);
      if (!ds.mdTable) return errText(`sample_rows is not available for '${dsName}' — it was loaded from GitHub and has no MotherDuck table`);
      const rows = await sampleTable(ds.mdTable, n);
      return text(rows);
    }
    case "compile_analytical_query": {
      const dsName = String(args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const ds = await findDataset(user.id, dsName);
      if (!ds) return errText(`dataset '${dsName}' not found`);
      const model = await latestModel(ds.id);
      if (!model) return errText(`dataset '${dsName}' has no Malloy model`);
      const files = await modelFileMap(model);
      const res = files.size > 1
        ? await compileMalloyFiles(files, "index.malloy", malloyQ)
        : await compileMalloy(model.source, malloyQ);
      if (!res.ok) return errText(`compile failed: ${res.error}`);
      return text({ sql: res.sql });
    }
    case "run_analytical_query": {
      const dsName = String(args.dataset ?? "");
      const malloyQ = String(args.malloy ?? "");
      const maxRows = Math.max(1, Math.min(10000, Number(args.max_rows ?? 10000)));
      const ds = await findDataset(user.id, dsName);
      if (!ds) return errText(`dataset '${dsName}' not found`);
      if (ds.status !== "ready") return errText(`dataset '${dsName}' is ${ds.status}, not ready`);
      const model = await latestModel(ds.id);
      if (!model) return errText(`dataset '${dsName}' has no Malloy model`);
      const files = await modelFileMap(model);
      const t0 = Date.now();
      try {
        const res = files.size > 1
          ? await runMalloyFiles(files, "index.malloy", malloyQ, { rowLimit: maxRows })
          : await runMalloy(model.source, malloyQ, { rowLimit: maxRows });
        const durationMs = Date.now() - t0;
        const capped = res.rows.slice(0, maxRows);
        await db.insert(queries).values({
          datasetId: ds.id,
          malloySource: malloyQ,
          compiledSql: res.sql,
          rowCount: res.rowCount,
          durationMs,
        });
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
          malloySource: malloyQ,
          error: msg,
        });
        return errText(`run failed: ${msg}`);
      }
    }
    default:
      return errText(`unknown tool: ${name}`);
  }
}
