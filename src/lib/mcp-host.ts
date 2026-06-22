// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The hosted explore surface, built on the shared mcp-engine. The deployed
// /mcp IS the engine's exploreSurface — the bespoke source-centric callTool it
// replaced has been deleted. This file is the HOST: it supplies the engine an
// `ExploreHost` (resolve + lease a model) and layers back the policy the engine
// deliberately leaves out — instance tagging, the mandatory `question`, the
// inquiry/share-slug/ltool_url recording (the "Query summary" nudge is
// currently disabled — see buildHostedExploreSurface), and the
// open_share_link tool.
//
// Addressing is SOURCE-centric (matching main): list_sources lists the sources
// you can query; describe_source(source, model_ref?) and query(source,
// model_ref?) resolve a bare source against the catalog when it's unique. A
// dataset is 1:1 with a model_ref (the dataset name), so once the engine reports
// the model_ref a query resolved to, recording is a direct dataset lookup.

import { desc } from "drizzle-orm";
import { db, datasets, inquiries, queries, type User } from "@/db";
import {
  compile,
  exploreSurface,
  modelCatalogEntry,
  renderInstructions,
  toContent,
  HOST_ONLY,
  type BoundModel,
  type ExploreHost,
  type ModelEntry,
  type RunResult,
  type WithHostOnly,
} from "@malloyyo/mcp-engine";

/** What the explore `query` tool returns on an executed run: the run result,
    the model it resolved to, and the host-only SQL channel. */
type QueryRunResult = WithHostOnly<RunResult & { model_ref?: string }>;
import { withModelRuntime } from "./malloy";
import {
  ensureConversation,
  latestModel,
  loadSharedQuery,
  logCall,
  modelFileMap,
  visibleDatasetWhere,
} from "./mcp-tools";
import { env } from "./env";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Every model file map roots at index.malloy; the pooled Runtime's URLReader
// keys files by this file:// URL (see malloy.ts fileUrl/splitFiles).
const ENTRY = new URL("file:///index.malloy");
const TAG = `[${env.INSTANCE_NAME}]`;
// Host-owned instruction block, appended to the engine's (instance-agnostic)
// explore instructions on the hosted surface only. Multi-instance routing is the
// host's concern — the engine doesn't tag tools and the local CLI doesn't either
// — so the line explaining the [INSTANCE] tag lives here, with the real name
// already interpolated (no token).
const HOST_POLICY =
  `Tools are tagged ${TAG} — if several instances are connected, ` +
  `route to the one the user means.`;

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}
function errText(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}
function ltoolUrl(baseUrl: string, slug: string | null): string | undefined {
  return slug ? `${baseUrl.replace(/\/$/, "")}/ltool/${slug}` : undefined;
}
/** A ready-to-render share link: the agent makes a markdown link from `text` +
    `url`. The host owns the LABEL (the instance brand) so it's real data, not a
    placeholder the agent has to assemble. */
type LtoolLink = { text: string; url: string };
function ltoolLink(baseUrl: string, slug: string | null): LtoolLink | undefined {
  const url = ltoolUrl(baseUrl, slug);
  return url ? { text: `↗ ${env.INSTANCE_NAME}`, url } : undefined;
}

type DatasetRow = { id: string; name: string };

// Datasets this user may query — via the shared visibility predicate.
async function visibleDatasets(userId: string): Promise<DatasetRow[]> {
  return db
    .select({ id: datasets.id, name: datasets.name })
    .from(datasets)
    .where(visibleDatasetWhere(userId))
    .orderBy(desc(datasets.createdAt));
}

// Resolve a model_ref (= dataset name) to its latest model version, scoped to
// what the user may see. Returns null for both "unknown" and "not visible".
async function findModelByRef(userId: string, ref: string) {
  const ds = (await visibleDatasets(userId)).find((d) => d.name === ref);
  if (!ds) return null;
  const model = await latestModel(ds.id);
  return model ? { ds, model } : null;
}

// Lease a pooled Runtime over one dataset's latest model and hand the engine a
// BoundModel. The whole hosted-vs-local difference lives here — same engine.
// readSource (for location-slicing) comes from withModelRuntime, keyed exactly
// as the runtime keys files, so the host doesn't re-derive that map.
async function leaseDataset<T>(
  model: { id: string; source: string },
  fn: (m: BoundModel) => Promise<T>,
): Promise<T> {
  const files = await modelFileMap(model);
  return withModelRuntime(files, model.id, (runtime, readSource) =>
    fn({ runtime, entry: ENTRY, readSource }),
  );
}

// The engine's ExploreHost: withModel resolves + leases a pooled Runtime; list
// compiles each visible model and renders it through the engine's ONE catalog
// projection (modelCatalogEntry) — no per-host copy of the listing shape.
function makeExploreHost(userId: string): ExploreHost {
  return {
    withModel: async (ref, fn) => {
      const found = await findModelByRef(userId, ref);
      // Same message for "absent" and "not visible" — a probe must not tell them
      // apart (the engine surfaces this thrown text to the agent).
      if (!found) throw new Error(`no model '${ref}' (unknown, or not visible to you)`);
      return leaseDataset(found.model, fn);
    },
    list: async () => {
      const entries: ModelEntry[] = [];
      for (const ds of await visibleDatasets(userId)) {
        const model = await latestModel(ds.id);
        if (!model) continue;
        try {
          entries.push(
            await leaseDataset(model, async (m) => {
              const compiled = await compile(m.runtime, m.entry, { exportedOnly: true });
              return compiled.ok && compiled.model
                ? modelCatalogEntry(ds.name, compiled.model)
                : { model_ref: ds.name };
            }),
          );
        } catch {
          entries.push({ model_ref: ds.name }); // a model that won't compile lists as a bare ref
        }
      }
      return { entries };
    },
  };
}

// Host policy: mint an inquiry (→ share slug), persist the query, log the call.
// Keyed off the model_ref the ENGINE resolved to (dataset is 1:1 with it), so
// the host never re-runs source→model resolution. Note: the explore surface
// does not return SQL on an executed run, so compiledSql is not recorded — the
// Malloy text (the shareable artifact) is.
async function recordQuery(
  user: User,
  args: Record<string, unknown>,
  result: QueryRunResult,
  baseUrl: string,
): Promise<{ link?: LtoolLink; logged: boolean }> {
  const modelRef = String(result.model_ref ?? args.model_ref ?? "");
  const found = modelRef ? await findModelByRef(user.id, modelRef) : null;
  // Couldn't resolve the dataset: the query still ran, so the caller logs a
  // bare audit row instead — `logged: false` tells it to.
  if (!found) return { logged: false };
  const question = String(args.question ?? "").trim();
  const malloyQ = String(args.malloy ?? "");
  const source = String(args.source ?? modelRef);
  // The explore surface withholds SQL from the agent but hands it to the host
  // via the host_only channel (see the engine's toContent) — record it, as the
  // old surface did.
  const compiledSql = result[HOST_ONLY]?.sql;
  const convId = await ensureConversation(user.id, undefined, source, found.ds.id);
  const [inq] = await db
    .insert(inquiries)
    .values({ conversationId: convId, question: question || source, sequence: 0 })
    .returning({ id: inquiries.id, slug: inquiries.slug });
  await db.insert(queries).values({
    datasetId: found.ds.id,
    userId: user.id,
    malloySource: malloyQ,
    compiledSql,
    rowCount: result.row_count,
    durationMs: result.total_time_ms,
  });
  await logCall({
    inquiryId: inq.id,
    userId: user.id,
    datasetId: found.ds.id,
    toolName: "query",
    source,
    malloyInput: malloyQ,
    compiledSql,
    rowCount: result.row_count,
    durationMs: result.total_time_ms,
  });
  return { link: ltoolLink(baseUrl, inq.slug), logged: true };
}

/** Pull a human error string off an engine result (`{ ok:false, problems }`) or
    a host ToolResult (`{ isError, content }`), for the audit `error` column. */
function resultError(result: Record<string, unknown>): string | undefined {
  const problems = result.problems;
  if (Array.isArray(problems) && problems.length > 0) {
    const msgs = problems
      .map((p) => (p && typeof p === "object" ? (p as { message?: unknown }).message : p))
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    if (msgs.length > 0) return msgs.join("; ");
  }
  if (typeof result.error === "string") return result.error;
  if (result.isError) {
    const first = (result.content as Array<{ text?: unknown }> | undefined)?.[0]?.text;
    if (typeof first === "string") return first;
  }
  return undefined;
}

async function openShareLink(args: Record<string, unknown>, baseUrl: string): Promise<ToolResult> {
  const slug = String(args.slug ?? "").trim().replace(/^.*\/ltool\//, "");
  if (!slug) return errText("slug is required");
  const res = await loadSharedQuery(slug);
  if (!res.ok) return errText(res.error);
  return text({
    instance: res.instance,
    source: res.source,
    question: res.question,
    malloy: res.malloy,
    ltool_link: ltoolLink(baseUrl, slug),
  });
}

const OPEN_SHARE_LINK = {
  name: "open_share_link",
  title: "Open a share link",
  description:
    `Resolve a ${env.INSTANCE_NAME} share link or slug back into its source, question, and Malloy. ` +
    `Use when the user pastes a share link; does not run the query.`,
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string", description: "Share slug, e.g. `main_k7m2qx9p4b`, or a full /ltool/ link." } },
    required: ["slug"],
    additionalProperties: false,
  },
} as const;

// Host policy: main required a `question` on every query (its share label). The
// engine leaves it optional, so the host re-adds it to the query tool's schema.
function withRequiredQuestion(name: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (name !== "query") return inputSchema;
  const schema = inputSchema as { required?: string[]; [k: string]: unknown };
  return { ...schema, required: Array.from(new Set([...(schema.required ?? []), "question"])) };
}

export interface HostedSurface {
  instructions: string;
  descriptors: Array<{ name: string; title?: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

// Build the per-user hosted explore surface: the engine's tools (instance-
// tagged) + open_share_link, with the executed query decorated for recording +
// sharing. route.ts wires this into initialize / tools/list / tools/call.
export function buildHostedExploreSurface(user: User, baseUrl: string): HostedSurface {
  const surface = exploreSurface(makeExploreHost(user.id));
  const byName = new Map(surface.tools.map((t) => [t.name, t]));

  const descriptors = [
    ...surface.tools.map((t) => ({
      name: t.name,
      title: t.title,
      // Instance tag prepended as HOST policy — the engine keeps descriptions
      // instance-agnostic; multi-instance routing is the host's concern.
      description: `${TAG} ${t.description}`,
      inputSchema: withRequiredQuestion(t.name, t.inputSchema),
    })),
    { ...OPEN_SHARE_LINK, description: `${TAG} ${OPEN_SHARE_LINK.description}` },
  ];

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Audit EVERY tool call (every tool, success or failure) to tool_calls. The
    // rich query record is minted by recordQuery on the success path; this is the
    // catch-all for every other path so nothing completes unlogged. Non-RUN_LABELS
    // tool names and errored rows are filtered out of the history/share views, so
    // these rows are audit-only and don't surface to users.
    const start = Date.now();
    const audit = (error?: string) =>
      logCall({
        userId: user.id,
        toolName: name,
        source: typeof args.source === "string" ? args.source : undefined,
        malloyInput: name === "query" && typeof args.malloy === "string" ? args.malloy : undefined,
        durationMs: Date.now() - start,
        error,
      });

    try {
      if (name === "open_share_link") {
        const result = await openShareLink(args, baseUrl);
        await audit(resultError(result as unknown as Record<string, unknown>));
        return result;
      }
      const tool = byName.get(name);
      if (!tool) {
        await audit(`unknown tool: ${name}`);
        return errText(`unknown tool: ${name}`);
      }

      const executing = name === "query" && args.execute !== false;
      // Host policy: an executing query must carry a question (its share label).
      if (executing && !String(args.question ?? "").trim()) {
        const msg = "'question' is required: a plain-English description of what this query answers.";
        await audit(msg);
        return errText(msg);
      }

      const result = (await tool.handler(args)) as Record<string, unknown>;

      // Decorate a successful executed query with the share link as the structured
      // `ltool_link` field (the Query-summary nudge that used to prepend here is
      // disabled — see below).
      if (executing && result.ok) {
        // One cast at the untyped wire boundary (the tool handler returns the
        // generic object) to the explore query shape; everything downstream
        // (recording, the host_only strip) is then typed.
        const runResult = result as unknown as QueryRunResult;
        const recorded = await recordQuery(user, args, runResult, baseUrl);
        // recordQuery mints the full row on success; if the dataset couldn't be
        // resolved it logged nothing, so fall back to a bare audit row.
        if (!recorded.logged) await audit();
        const link = recorded.link;
        // host_only carried the SQL for recording (above); it must NOT reach the
        // agent — strip it from the payload the agent sees.
        const { [HOST_ONLY]: _hostOnly, ...rest } = runResult;
        const withLink = { ...rest, ltool_link: link };
        // DISABLED (rescuable): the per-query "Query summary" nudge was shipped as
        // a bare text block prepended to the JSON payload. Two problems flagged
        // repeatedly by consuming models: (1) it breaks any consumer that
        // JSON.parses the result (leading prose before the {...}); (2) an
        // imperative aimed at the model inside a tool result is exactly the shape
        // hosts/models distrust as injection, so it was unreliable anyway. The
        // share link already rides as the structured `ltool_link` field — let the
        // client render it. Restore by re-adding the reminder text block below.
        //   const reminder =
        //     `End your reply with a "Query summary": (1) the question in plain English, ` +
        //     `(2) the Malloy logic (filters, grouping, aggregation, ordering), ` +
        //     `(3) post-processing outside Malloy or "none".` +
        //     (link ? ` Then append \`ltool_link\` as a markdown link using its \`text\` and \`url\`.` : "");
        return {
          content: [
            // { type: "text", text: reminder },
            { type: "text", text: JSON.stringify(withLink, null, 2) },
          ],
          structuredContent: withLink,
        };
      }
      // Everything else — non-query tools, execute:false (compile-only), and
      // FAILED queries — gets a bare audit row (with the error string when the
      // result reports one). This is the A+B fix: nothing returns unlogged.
      await audit(result.ok === false ? resultError(result) : undefined);
      return toContent(result) as ToolResult;
    } catch (e) {
      // A thrown handler (the engine throws only on programmer misuse, but the
      // host's resolution/lease can also throw) — record the failure, then let it
      // propagate to the route handler's error response as before.
      await audit(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  // Render the instance name into the engine's instructions ({{INSTANCE_NAME}}
  // → env.INSTANCE_NAME) — the same instance stamp the descriptors get via TAG —
  // then append the host-only policy block (multi-instance tag routing).
  return {
    instructions: `${renderInstructions(surface.instructions, env.INSTANCE_NAME)}\n\n${HOST_POLICY}`,
    descriptors,
    call,
  };
}
