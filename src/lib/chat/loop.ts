// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The chat agent loop: a conversation with a model about one source, emitted as
// events so the route can stream it.
//
// A streaming sibling of src/lib/ask.ts rather than a rewrite of it. Ask is
// single-shot and keeps only the final Malloy; a chat keeps the prose, the tool
// calls, and the results, and has to say what is happening while it happens. The
// pieces that are genuinely the same — which models are offered, how a request is
// shaped per model, what a run costs — are imported rather than copied.
//
// TWO THINGS DIFFER FROM ASK, both deliberate.
//
// 1. An executed `query` does NOT go to the tool surface. It goes to
//    runQueryForWeb, which returns a `stableResult` the browser can render, mints
//    the share slug that becomes the ltool link, and records the run to `history`
//    — none of which the surface offers, because the engine strips stable_result
//    before a tool result is built (mcp-engine/src/surfaces/budget.ts). The
//    alternative was running every query twice. Everything else — describe_source,
//    yo_help, and a validate-only query — goes to the surface untouched.
//
// 2. What the model reads and what the person sees are different sizes. One
//    execution at the full row limit; the model is fed a LOOP_ROWS slice so it
//    cannot drag a table through the context window, and the whole result is kept
//    for the screen.

import Anthropic from "@anthropic-ai/sdk";
import type { User } from "@/db";
import type { HostedSurface } from "../mcp-host";
import {
  LOOP_ROWS,
  askCostUsd,
  modelShape,
  pickEffort,
  pickModel,
  type AskEffort,
  type AskUsage,
} from "../ask";
// Type-only: the value is imported lazily below. `../mcp-tools` reaches @/db,
// which reads DATABASE_URL at import time — the same reason ask.ts defers
// mcp-host. Keeping it out of the static graph is what lets this module be
// unit-tested without a database.
import type { runQueryForWeb } from "../mcp-tools";
import { env } from "../env";
import { logger, serializeErr } from "../logger";

/** Model turns in one exchange. Higher than Ask's, because a conversation can
    legitimately want a look around before answering — but still a hard ceiling,
    so a model that will not converge costs a bounded amount. */
const MAX_STEPS = 10;

/** Per-turn output cap. Generous next to Ask's: a chat answer is prose as well
    as a query, and being cut off mid-sentence is visible in a way a truncated
    tool call is not. */
const MAX_TOKENS = 16_000;

/** Rows fetched for the SCREEN when the model runs a query. The model still only
    reads LOOP_ROWS of them. */
const RENDER_ROWS = 1_000;

const TASK = `You are a data analyst working with someone in a chat window, over
one Malloy source. Answer their questions by querying it.

Tools:
- describe_source — the source's fields, measures and views. Call it before your
  first query; do not guess field names.
- query — runs Malloy and shows you up to ${LOOP_ROWS} rows. The person sees the
  full result rendered as a table or chart, so do NOT paste rows back to them.
  Refer to what the result shows.
- yo_help — Malloy guidance by topic. Compile problems carry a help_topic; pass
  it here rather than guessing at syntax. \`explore/charting-results\` is how to
  draw a chart instead of a table.

Charts:
- A result renders as a table unless you tag the query. When the question is
  about a RANKING, tag \`# bar_chart\`; about CHANGE OVER TIME, \`# line_chart\`;
  about whether two measures relate, \`# scatter_chart\`. The tag goes on its own
  line directly above \`run:\`.
- Name the channels — \`# bar_chart { x=brand y=total_sales }\` — because an
  unnamed spare dimension is silently promoted to a colour series, and three
  untagged dimensions are refused at draw time.
- Leave it a table when the answer is a set of numbers to read rather than a
  shape to see. A chart of a wide detail table is worse than the table.

How to work:
- Look at what came back before you answer. If a query returns ZERO ROWS, that is
  a bug you can still fix, not an answer — the usual cause is a filter written
  against a guessed representation of a value (a code where the column stores a
  full label, a different capitalisation, a plural). You are told a column's name
  and type, never what is in it, so check:
      run: <source> -> { group_by: <the filtered field>; aggregate: count(); limit: 20 }
  then rewrite the filter and run it again. Consider the same when a count looks
  impossibly low.
- Do the work in Malloy — ordering, limiting, aggregation — rather than
  describing what you would do.
- Every query you run is shown to the person, so run the one that answers the
  question rather than a pile of exploratory ones. A check is fine; say why.

How to write:
- Prose, in markdown. Brief. Lead with the answer, then what it rests on.
- Never restate the table. They can see it. Say what it means.
- If a question is ambiguous, choose the most obvious reading, answer it, and say
  which reading you took.
- If you cannot answer from this source, say so plainly rather than guessing.`;

/** What the loop emits. The route serialises these as SSE; the client rebuilds
    the conversation from them. */
export type ChatEvent =
  /** A fragment of assistant prose. */
  | { type: "text"; text: string }
  /** The model has asked for a tool. Emitted before it runs, so the UI can show
      the query while it executes rather than after. */
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  /** A tool finished. `stableResult` is present only for an executed query. */
  | {
      type: "tool_result";
      id: string;
      ok: boolean;
      text: string;
      malloy?: string;
      sql?: string;
      rowCount?: number;
      slug?: string | null;
      stableResult?: unknown;
    }
  | { type: "done"; steps: number; usage: AskUsage; costUsd: number | null; model: string; effort: AskEffort | null }
  | { type: "error"; message: string };

export type ChatTurnInput = {
  user: User;
  baseUrl: string;
  dataset: string;
  source: string;
  /** The conversation so far, oldest first, as stored. The new user message is
      expected to be the last entry. */
  messages: Anthropic.MessageParam[];
  model?: string;
  effort?: string;
  userAgent?: string | null;
  /** Aborted when the client goes away — an abandoned chat must stop spending. */
  signal?: AbortSignal;
};

export type ChatDependencies = {
  /** Runs one model turn, reporting text as it arrives and resolving with the
      assembled message. Injected for the test. */
  stream?: (
    params: Anthropic.MessageCreateParamsStreaming,
    onText: (t: string) => void,
    signal?: AbortSignal,
  ) => Promise<Anthropic.Message>;
  surface?: HostedSurface;
  /** Injected for the test; defaults to the real runQueryForWeb. */
  runQuery?: typeof runQueryForWeb;
};

/**
 * Move the conversation's cache breakpoint to the end of the transcript.
 *
 * Without it only the frozen prefix (tools + system) is cached and the whole
 * transcript is re-sent at full rate every turn — which in a chat grows without
 * bound. The breakpoint MOVES rather than accumulates: at most four are allowed
 * per request. Clearing the old mark costs nothing, since a breakpoint says
 * "cache up to here" and is not part of what is hashed.
 */
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if ("cache_control" in block) delete (block as { cache_control?: unknown }).cache_control;
    }
  }
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === "string" || last.content.length === 0) return;
  (last.content[last.content.length - 1] as { cache_control?: unknown }).cache_control = {
    type: "ephemeral",
  };
}

/** The assistant turns and tool results this exchange produced, for the caller
    to persist. Returned rather than written here so the loop stays a pure
    conversation and the route owns storage. */
export type ChatTurnOutcome = {
  /** Appended to `messages` in order — the API's own record of the exchange. */
  appended: Anthropic.MessageParam[];
  /** Renderable results, keyed by the tool_use id that produced them. */
  results: Map<string, { malloy: string; sql: string; rowCount: number; slug: string | null; stableResult: unknown }>;
  steps: number;
  usage: AskUsage;
  costUsd: number | null;
  model: string;
  effort: AskEffort | null;
};

/**
 * Run one exchange: the model answers, using tools, until it stops asking for
 * them. Reports events through `onEvent` as they happen; resolves with what to
 * persist.
 *
 * A callback rather than an async generator on purpose. Text arrives through the
 * SDK's own event emitter WHILE the turn is still resolving, and a generator can
 * only yield from its own body — bridging the two needs a queue, and the obvious
 * cheap version of that queue is module state, which two concurrent chats would
 * share. A callback has neither problem.
 */
export async function runChatTurn(
  input: ChatTurnInput,
  onEvent: (e: ChatEvent) => void,
  deps: ChatDependencies = {},
): Promise<ChatTurnOutcome> {
  const model = pickModel(input.model);
  const shape = modelShape(model, pickEffort(input.effort));
  const effort = (shape.output_config?.effort as AskEffort | undefined) ?? null;
  const runQuery = deps.runQuery ?? (await import("../mcp-tools")).runQueryForWeb;

  const hosted =
    deps.surface ??
    (await import("../mcp-host")).buildHostedExploreSurface(input.user, input.baseUrl, {
      userAgent: input.userAgent,
      authorModel: model,
      style: "inapp",
      tools: ["describe_source", "query", "yo_help"],
      entrypoint: "chat",
      // The loop's own surface calls mint nothing: a validate or a describe is
      // not a result anyone shares. Executed queries go through runQueryForWeb,
      // which mints the slug that becomes the ltool link.
      mintSlugs: false,
    });

  const tools: Anthropic.Tool[] = hosted.descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.inputSchema as Anthropic.Tool.InputSchema,
  }));

  const system = `${hosted.instructions}\n\n${TASK}\n\nThe source is \`${input.source}\` in the model \`${input.dataset}\`.`;

  const messages = [...input.messages];
  const appended: Anthropic.MessageParam[] = [];
  const results: ChatTurnOutcome["results"] = new Map();
  const usage: AskUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let steps = 0;

  const outcome = (): ChatTurnOutcome => ({
    appended,
    results,
    steps,
    usage,
    costUsd: askCostUsd(model, usage),
    model,
    effort,
  });

  const stream: NonNullable<ChatDependencies["stream"]> =
    deps.stream ??
    ((params, onText, signal) => {
      const client = new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        ...(env.ANTHROPIC_WORKSPACE_ID
          ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
          : {}),
      });
      const s = client.messages.stream(params, { signal });
      s.on("text", onText);
      return s.finalMessage();
    });

  while (steps < MAX_STEPS) {
    if (input.signal?.aborted) return outcome();
    steps++;
    moveCacheBreakpoint(messages);

    let response: Anthropic.Message;
    try {
      // The SDK's stream helper emits text deltas through the `text` event; the
      // route bridges those into `text` events. finalMessage() resolves with the
      // assembled turn, which is what has to be replayed.
      response = await stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
          stream: true,
          ...shape,
        },
        (text) => onEvent({ type: "text", text }),
        input.signal,
      );
    } catch (e) {
      if (input.signal?.aborted) return outcome();
      logger.error("chat model call failed", { model, steps, error: serializeErr(e).message });
      onEvent({ type: "error", message: apiError(e) });
      return outcome();
    }

    usage.input += response.usage?.input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;
    usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage?.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      onEvent({ type: "error", message: "The model declined to answer that." });
      return outcome();
    }

    // Whole, including thinking blocks: they must be replayed unchanged.
    messages.push({ role: "assistant", content: response.content });
    appended.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (input.signal?.aborted) return outcome();
      const args: Record<string, unknown> = { ...(use.input as Record<string, unknown>) };
      onEvent({ type: "tool_start", id: use.id, name: use.name, input: args });

      const executed = use.name === "query" && args.execute !== false;
      const event = executed
        ? await runExecutedQuery(use, args, input, runQuery, model)
        : await runSurfaceTool(use, args, hosted);

      onEvent(event);
      if (event.type === "tool_result" && event.stableResult !== undefined) {
        results.set(use.id, {
          malloy: event.malloy ?? "",
          sql: event.sql ?? "",
          rowCount: event.rowCount ?? 0,
          slug: event.slug ?? null,
          stableResult: event.stableResult,
        });
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: [{ type: "text", text: event.type === "tool_result" ? event.text : "failed" }],
        is_error: event.type !== "tool_result" || !event.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
    appended.push({ role: "user", content: toolResults });
  }

  const done = outcome();
  onEvent({
    type: "done",
    steps: done.steps,
    usage: done.usage,
    costUsd: done.costUsd,
    model: done.model,
    effort: done.effort,
  });
  return done;
}

/** An executed query: one run at RENDER_ROWS, of which the model reads a slice. */
async function runExecutedQuery(
  use: Anthropic.ToolUseBlock,
  args: Record<string, unknown>,
  input: ChatTurnInput,
  runQuery: typeof runQueryForWeb,
  model: string,
): Promise<ChatEvent> {
  const malloy = typeof args.malloy === "string" ? args.malloy : "";
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!malloy) {
    return { type: "tool_result", id: use.id, ok: false, text: "'malloy' is required." };
  }
  const res = await runQuery(
    input.user.id,
    input.source,
    malloy,
    RENDER_ROWS,
    input.dataset,
    {
      userAgent: input.userAgent,
      authorModel: model,
      question: question || null,
      entrypoint: "chat",
    },
  );
  if (!res.ok) {
    return { type: "tool_result", id: use.id, ok: false, text: res.error };
  }
  // The model reads a slice; the screen gets everything.
  const seen = res.rows.slice(0, LOOP_ROWS);
  const note =
    res.rowCount > seen.length
      ? `\n\n(${seen.length} of ${res.rowCount} rows shown to you; the person sees all ${res.rowCount}.)`
      : "";
  return {
    type: "tool_result",
    id: use.id,
    ok: true,
    text: `${JSON.stringify({ row_count: res.rowCount, rows: seen }, null, 2)}${note}`,
    malloy,
    sql: res.sql,
    rowCount: res.rowCount,
    slug: res.slug,
    stableResult: res.stableResult,
  };
}

/** describe_source, yo_help, and a validate-only query: unchanged surface calls. */
async function runSurfaceTool(
  use: Anthropic.ToolUseBlock,
  args: Record<string, unknown>,
  hosted: HostedSurface,
): Promise<ChatEvent> {
  try {
    const result = await hosted.call(use.name, args);
    const text = result.content.map((c) => c.text).join("\n");
    const ok =
      result.isError !== true &&
      (result.structuredContent as { ok?: unknown } | undefined)?.ok !== false;
    return { type: "tool_result", id: use.id, ok, text };
  } catch (e) {
    // A thrown handler is data to the model, not the end of the exchange — it
    // gets a chance to correct.
    return { type: "tool_result", id: use.id, ok: false, text: serializeErr(e).message };
  }
}

function apiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Chat is misconfigured: the API key was rejected.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited. Try again in a moment.";
  if (e instanceof Anthropic.BadRequestError) {
    const body = (e.error as { error?: { message?: unknown } } | undefined)?.error;
    const detail = typeof body?.message === "string" ? body.message : "the model rejected the request";
    return `Chat is misconfigured: ${detail.replace(/\.*$/, "")}.`;
  }
  if (e instanceof Anthropic.APIError) return "The model service is unavailable right now.";
  return "Chat failed unexpectedly.";
}
