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
import { db, datasets, type User } from "@/db";
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
  latestModel,
  loadSharedQuery,
  modelFileMap,
  recordHistory,
  visibleDatasetWhere,
  type RecordHistoryFields,
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
  `route to the one the user means. On every tool call, set \`model\` to your own ` +
  `model identifier (e.g. "claude-opus-4-8") so runs can be attributed by model.`;

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

// Host policy: ask EVERY tool for the calling model, so runs can be attributed
// by model. The engine schemas don't carry it, so the host injects it (required).
// Self-reported and therefore UNTRUSTED — the x-author-model header still wins.
// This is the only model signal available from clients (e.g. claude.ai web) that
// never send that header.
function withModelParam(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = inputSchema as { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      model: {
        type: "string",
        description:
          'The model identifier you (the calling assistant) are running as, e.g. "claude-opus-4-8". ' +
          "Report your own model so this run can be attributed.",
      },
    },
    required: Array.from(new Set([...(schema.required ?? []), "model"])),
  };
}

export interface HostedSurface {
  instructions: string;
  descriptors: Array<{ name: string; title?: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

// Build the per-user hosted explore surface: the engine's tools (instance-
// tagged) + open_share_link. Every call is recorded to `history` (with the
// client user_agent and the request's author_model), and a successful run is
// decorated with its freshly-minted share link. route.ts wires this into
// initialize / tools/list / tools/call.
export function buildHostedExploreSurface(
  user: User,
  baseUrl: string,
  ctx: { userAgent?: string | null; authorModel?: string | null } = {},
): HostedSurface {
  const surface = exploreSurface(makeExploreHost(user.id));
  const byName = new Map(surface.tools.map((t) => [t.name, t]));
  const userAgent = ctx.userAgent ?? null;
  // Trusted model attribution from the x-author-model header (a harness sets it);
  // falls back per-call to the self-reported `model` arg, then 'assistant'.
  const headerModel = ctx.authorModel ?? null;

  const descriptors = [
    ...surface.tools.map((t) => ({
      name: t.name,
      title: t.title,
      // Instance tag prepended as HOST policy — the engine keeps descriptions
      // instance-agnostic; multi-instance routing is the host's concern.
      description: `${TAG} ${t.description}`,
      inputSchema: withModelParam(withRequiredQuestion(t.name, t.inputSchema)),
    })),
    {
      ...OPEN_SHARE_LINK,
      description: `${TAG} ${OPEN_SHARE_LINK.description}`,
      inputSchema: withModelParam(OPEN_SHARE_LINK.inputSchema as Record<string, unknown>),
    },
  ];

  const strArg = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Record EVERY tool call to `history` — success, validate-only, or failure —
    // so nothing completes unrecorded (syntax-error attempts included). A
    // successful run additionally mints a share slug (returned as ltool_link).
    const start = Date.now();
    const isQuery = name === "query";
    // Self-reported model from the host-injected `model` arg; the trusted header
    // wins if present.
    const declaredModel = strArg(args.model)?.trim() || undefined;
    const authorModel = headerModel ?? declaredModel ?? "assistant";
    // `model` is host-injected — strip it before the engine handler, which
    // validates args against its own schema (additionalProperties: false).
    const { model: _model, ...toolArgs } = args;
    const record = (extra: Partial<RecordHistoryFields>) =>
      recordHistory({
        userId: user.id,
        toolName: name,
        source: strArg(args.source),
        durationMs: Date.now() - start,
        userAgent,
        authorModel,
        ...extra,
      });

    try {
      if (name === "open_share_link") {
        const result = await openShareLink(toolArgs, baseUrl);
        await record({ error: resultError(result as unknown as Record<string, unknown>) });
        return result;
      }
      const tool = byName.get(name);
      if (!tool) {
        await record({ error: `unknown tool: ${name}` });
        return errText(`unknown tool: ${name}`);
      }

      const executing = isQuery && args.execute !== false;
      // Host policy: EVERY query call (run AND validate) must carry a question —
      // the synopsis is the analytics grouping key and the share label.
      if (isQuery && !String(args.question ?? "").trim()) {
        const msg = "'question' is required: a plain-English description of what this query answers.";
        await record({ malloyInput: strArg(args.malloy), question: null, executed: executing, error: msg });
        return errText(msg);
      }

      const result = (await tool.handler(toolArgs)) as Record<string, unknown>;
      const succeeded = result.ok !== false;
      const qr = result as unknown as QueryRunResult;

      // For query calls, resolve the dataset (1:1 with the model_ref the engine
      // reported) — needed on the history row for every query call, run or not.
      let datasetId: string | null = null;
      if (isQuery) {
        const modelRef = String(qr.model_ref ?? args.model_ref ?? "");
        const found = modelRef ? await findModelByRef(user.id, modelRef) : null;
        datasetId = found?.ds.id ?? null;
      }

      const runOk = isQuery && executing && succeeded;
      const rec = await record({
        datasetId,
        question: isQuery ? String(args.question ?? "") : null,
        malloyInput: isQuery ? strArg(args.malloy) : undefined,
        // Run artifacts (compiled SQL, row count) only for an executed run — a
        // validate compiles but nothing actually runs.
        compiledSql: runOk ? qr[HOST_ONLY]?.sql : undefined,
        rowCount: runOk ? qr.row_count : undefined,
        durationMs: runOk ? qr.total_time_ms : Date.now() - start,
        executed: isQuery ? executing : null,
        error: succeeded ? undefined : resultError(result),
        mintSlug: runOk,
      });

      // Decorate a successful executed query with the share link as the
      // structured `ltool_link` field. (The "Query summary" nudge that used to
      // prepend here is disabled: prose before the JSON broke parsers, and an
      // imperative aimed at the model inside a tool result reads as injection.
      // The link rides as structured data instead.)
      if (runOk) {
        // host_only carried the SQL for recording; it must NOT reach the agent.
        const { [HOST_ONLY]: _hostOnly, ...rest } = qr;
        const withLink = { ...rest, ltool_link: ltoolLink(baseUrl, rec.slug) };
        return {
          content: [{ type: "text", text: JSON.stringify(withLink, null, 2) }],
          structuredContent: withLink,
        };
      }
      return toContent(result) as ToolResult;
    } catch (e) {
      // A thrown handler (the engine throws only on programmer misuse; the
      // host's resolution/lease can also throw) — record the failure, then let
      // it propagate to the route handler's error response.
      await record({
        malloyInput: isQuery ? strArg(args.malloy) : undefined,
        executed: isQuery ? args.execute !== false : null,
        error: e instanceof Error ? e.message : String(e),
      });
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
