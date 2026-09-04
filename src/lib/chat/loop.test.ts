// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The chat loop, driven by a scripted model, a fake surface and a fake runner.
//
// What is worth pinning is the part that is not the model: which execution path
// a tool call takes, that a rendered result never leaks back into the model's
// context, and that an abandoned chat stops spending.

import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { User } from "@/db";
import type { HostedSurface, ToolResult } from "../mcp-host";
import { runChatTurn, type ChatEvent, type ChatDependencies, type ChatTurnInput } from "./loop";

const USER = { id: "u1" } as User;

const INPUT: ChatTurnInput = {
  user: USER,
  baseUrl: "https://example.test",
  dataset: "ecommerce",
  source: "order_items",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "top brands?" }] }],
};

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 10,
};

function toolTurn(name: string, input: Record<string, unknown>, id = "t1"): Anthropic.Message {
  return {
    stop_reason: "tool_use",
    usage: USAGE,
    content: [{ type: "tool_use", id, name, input }],
  } as unknown as Anthropic.Message;
}

function textTurn(text = "Levi's leads."): Anthropic.Message {
  return {
    stop_reason: "end_turn",
    usage: USAGE,
    content: [{ type: "text", text }],
  } as unknown as Anthropic.Message;
}

/** Plays turns in order, reporting each turn's text through onText first. */
function scripted(turns: Anthropic.Message[]): NonNullable<ChatDependencies["stream"]> {
  let i = 0;
  return async (_params, onText) => {
    assert.ok(i < turns.length, "the loop asked for more turns than the script has");
    const turn = turns[i++];
    for (const b of turn.content) if (b.type === "text") onText(b.text);
    return turn;
  };
}

function fakeSurface() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const surface: HostedSurface = {
    instructions: "INSTRUCTIONS",
    descriptors: [
      { name: "describe_source", description: "d", inputSchema: { type: "object" } },
      { name: "query", description: "q", inputSchema: { type: "object" } },
    ],
    async call(name, args): Promise<ToolResult> {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "surface says fine" }], structuredContent: { ok: true } };
    },
  };
  return { surface, calls };
}

/** Stands in for runQueryForWeb. `rows` is how many the run returns;
    `annotations` is what the compiled result carries back. */
function fakeRunner(rows: number, annotations?: Array<{ value: string }>) {
  const calls: Array<{ malloy: string; maxRows: number; dataset: string | null | undefined }> = [];
  const run = (async (
    _userId: string,
    _source: string,
    malloy: string,
    maxRows: number,
    dataset?: string | null,
  ) => {
    calls.push({ malloy, maxRows, dataset });
    return {
      ok: true as const,
      slug: "main_abc123",
      rows: Array.from({ length: rows }, (_, i) => ({ brand: `b${i}`, sales: i })),
      sql: "SELECT 1",
      rowCount: rows,
      truncated: false,
      durationMs: 5,
      stableResult: { schema: {}, data: { kind: "big-render-payload" }, ...(annotations ? { annotations } : {}) },
    };
  }) as unknown as ChatDependencies["runQuery"];
  return { run, calls };
}

/** A runner returning exactly these rows — for shapes fakeRunner cannot make. */
function rowRunner(rows: Record<string, unknown>[]) {
  const run = (async () => ({
    ok: true as const,
    slug: "main_abc123",
    rows,
    sql: "SELECT 1",
    rowCount: rows.length,
    truncated: false,
    durationMs: 5,
    stableResult: { schema: {}, data: {} },
  })) as unknown as ChatDependencies["runQuery"];
  return { run };
}

/** One decade row of the shape that cost a real chat ~250k tokens: a nest of
    `actors`, each with a nest of genres. ~8kB per row. */
function nestedRow(decade: number) {
  return {
    decade,
    top_actors: Array.from({ length: 100 }, (_, i) => ({
      name: `Actor Number ${i}`,
      nconst: `nm${String(i).padStart(7, "0")}`,
      total_ratings: 57.732 + i,
      genre_breakdown: [
        { genre: "Drama", title_count: 3 },
        { genre: "War", title_count: 1 },
      ],
    })),
  };
}

async function collect(deps: ChatDependencies, input: ChatTurnInput = INPUT) {
  const events: ChatEvent[] = [];
  const outcome = await runChatTurn(input, (e) => events.push(e), deps);
  return { events, outcome };
}

test("an executed query goes to runQueryForWeb, not the tool surface", async () => {
  const { surface, calls } = fakeSurface();
  const { run, calls: runs } = fakeRunner(3);
  const malloy = "run: order_items -> { group_by: brand }";

  await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy, question: "top brands" }), textTurn()]),
  });

  assert.equal(runs.length, 1, "the query ran through runQueryForWeb");
  // Formatted BEFORE it runs, so what executed is what the transcript shows.
  assert.equal(runs[0].malloy, "run: order_items -> {\n  group_by: brand\n}");
  assert.equal(calls.length, 0, "and never reached the surface");
});

test("describe_source, yo_help and a validate-only query go to the surface", async () => {
  const { surface, calls } = fakeSurface();
  const { run, calls: runs } = fakeRunner(3);

  await collect({
    surface,
    runQuery: run,
    stream: scripted([
      toolTurn("describe_source", { source: "order_items" }, "t1"),
      toolTurn("query", { malloy: "run: x -> { }", execute: false }, "t2"),
      textTurn(),
    ]),
  });

  assert.deepEqual(calls.map((c) => c.name), ["describe_source", "query"]);
  assert.equal(runs.length, 0, "nothing was executed");
});

test("the model reads a slice; the screen gets the whole result", async () => {
  const { surface } = fakeSurface();
  const { run, calls: runs } = fakeRunner(400);

  const { events, outcome } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn()]),
  });

  // One execution, at the render limit rather than the model's.
  assert.equal(runs.length, 1);
  assert.equal(runs[0].maxRows, 1000);

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(result.rowCount, 400, "the event carries the true count");

  // The model was handed 50, and told so.
  const parsed = JSON.parse(result.text.split("\n\n(")[0]);
  assert.equal(parsed.rows.length, 50);
  assert.match(result.text, /50 of 400 rows shown to you/);

  assert.equal(outcome.results.size, 1, "and the full result is kept for the screen");
});

test("a rendered result never enters the model's context", async () => {
  // stableResult is large and the model already read the rows. If it leaked into
  // the replayed messages, every subsequent turn would re-send it at full rate.
  const { surface } = fakeSurface();
  const { run } = fakeRunner(3);

  const { outcome } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn()]),
  });

  const replayed = JSON.stringify(outcome.appended);
  assert.equal(replayed.includes("big-render-payload"), false, "stableResult must not be replayed");
  assert.ok(outcome.results.get("t1")?.stableResult, "but it is kept for the UI");
});

test("results are keyed by the tool_use id that produced them", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(2);

  const { outcome } = await collect({
    surface,
    runQuery: run,
    stream: scripted([
      toolTurn("query", { malloy: "one" }, "call-a"),
      toolTurn("query", { malloy: "two" }, "call-b"),
      textTurn(),
    ]),
  });

  assert.deepEqual([...outcome.results.keys()], ["call-a", "call-b"]);
  assert.equal(outcome.results.get("call-a")?.malloy, "one");
  assert.equal(outcome.results.get("call-b")?.malloy, "two");
});

test("text streams out, and a tool announces itself before it runs", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(1);

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn("Levi's leads.")]),
  });

  const kinds = events.map((e) => e.type);
  assert.ok(kinds.indexOf("tool_start") < kinds.indexOf("tool_result"), "start precedes result");
  assert.ok(events.some((e) => e.type === "text" && e.text === "Levi's leads."));
  assert.equal(events[events.length - 1].type, "done");
});

test("an aborted chat stops spending", async () => {
  const { surface } = fakeSurface();
  const { run, calls: runs } = fakeRunner(1);
  const controller = new AbortController();
  let turns = 0;

  const { outcome } = await collect({
    surface,
    runQuery: run,
    stream: async () => {
      turns++;
      controller.abort(); // the client goes away mid-turn
      return toolTurn("query", { malloy: "run: x -> { }" }, `t${turns}`);
    },
  }, { ...INPUT, signal: controller.signal });

  assert.equal(turns, 1, "no further model calls after the abort");
  assert.equal(runs.length, 0, "and the tool it asked for never ran");
  assert.equal(outcome.steps, 1);

  // What gets PERSISTED has to stay replayable. An assistant message whose
  // tool_use has no tool_result after it is rejected by the API on every later
  // turn — and the route persists `appended` whatever happened, so leaving one
  // behind bricks the chat for good, with no UI to remove a message.
  const last = outcome.appended.at(-1);
  assert.equal(last?.role, "user", "the turn ends with the tool results, not the request");
  const answered = new Set(
    (last?.content as Array<{ tool_use_id?: string }>).map((b) => b.tool_use_id),
  );
  for (const m of outcome.appended) {
    for (const b of m.content as Array<{ type?: string; id?: string }>) {
      if (b.type === "tool_use") {
        assert.ok(answered.has(b.id), `tool_use ${b.id} was left unanswered`);
      }
    }
  }
});

test("a model that never stops asking for tools hits the step cap", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(1);
  let turns = 0;

  const { outcome } = await collect({
    surface,
    runQuery: run,
    stream: async () => toolTurn("query", { malloy: "run: x -> { }" }, `t${++turns}`),
  });

  assert.equal(outcome.steps, 10, "bounded, so a runaway conversation costs a known amount");
});

test("exactly one cache breakpoint per request, always last", async () => {
  const seen: Anthropic.MessageCreateParamsStreaming[] = [];
  const { surface } = fakeSurface();
  const { run } = fakeRunner(1);

  await collect({
    surface,
    runQuery: run,
    stream: async (params) => {
      seen.push(JSON.parse(JSON.stringify(params)));
      return seen.length < 2 ? toolTurn("query", { malloy: "run: x -> { }" }, `t${seen.length}`) : textTurn();
    },
  });

  for (const [i, params] of seen.entries()) {
    const marked = params.messages.flatMap((m, mi) =>
      typeof m.content === "string"
        ? []
        : m.content.flatMap((b, bi) => ("cache_control" in b ? [`${mi}.${bi}`] : [])),
    );
    assert.equal(marked.length, 1, `request ${i} should carry exactly one breakpoint`);
    const last = params.messages[params.messages.length - 1];
    const lastIdx = typeof last.content === "string" ? -1 : last.content.length - 1;
    assert.equal(marked[0], `${params.messages.length - 1}.${lastIdx}`);
  }
});

test("a chart tag that failed to attach is reported back to the model", async () => {
  // Malloy attaches a tag to the next line, so one written inside the query block
  // lands on a field and vanishes from the result. It compiles, it runs, and
  // nothing says the chart was lost — so the loop has to say it.
  const { surface } = fakeSurface();
  const { run } = fakeRunner(20, [{ value: "#(malloy) source.name = baby_names\n" }]);
  const malloy = [
    "run: baby_names -> {",
    "  # line_chart { x=birth_year y=total_babies }",
    "  group_by: birth_year",
    "}",
  ].join("\n");

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.text, /NO CHART WAS DRAWN/);
  assert.match(result.text, /line_chart/);
  assert.match(result.text, /directly above/);
});

test("a chart tag that DID attach is not complained about", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(20, [
    { value: "# line_chart { x=birth_year y=total_babies }\n" },
    { value: "#(malloy) source.name = baby_names\n" },
  ]);
  const malloy = "# line_chart { x=birth_year y=total_babies }\nrun: baby_names -> { group_by: birth_year }";

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(/NO CHART/.test(result.text), false);
});

test("an untagged query is never told about charts", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(5);

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { group_by: y }" }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(/NO CHART/.test(result.text), false);
});

test("a nested result is bounded by BYTES, not by a row count", async () => {
  // The row cap is 50 and this is 12 rows, so a row cap sees nothing wrong.
  // Serialized it is ~100kB, and it used to go to the model whole and then get
  // replayed on every later turn.
  const { surface } = fakeSurface();
  const { run } = rowRunner(Array.from({ length: 12 }, (_, i) => nestedRow(1910 + i * 10)));

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.ok(
    result.text.length < 40_000,
    `the model was handed ${result.text.length} characters`,
  );
  const parsed = JSON.parse(result.text.split("\n\n(")[0]);
  assert.equal(parsed.row_count, 12, "and is still told the true count");
  assert.ok(parsed.rows.length > 0 && parsed.rows.length < 12, "some rows, not all");
  assert.match(result.text, /of 12 rows shown to you/);
});

test("a single row over the budget yields none, and says why", async () => {
  const { surface } = fakeSurface();
  // One row of 400 nested actors — bigger on its own than the whole budget.
  const huge = { decade: 1990, top_actors: nestedRow(1990).top_actors.flatMap(() => nestedRow(1990).top_actors.slice(0, 4)) };
  const { run } = rowRunner([huge]);

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  const parsed = JSON.parse(result.text.split("\n\n(")[0]);
  assert.equal(parsed.rows.length, 0);
  // Zero rows without a reason invites the model to run it again unchanged.
  assert.match(result.text, /NO ROWS SHOWN TO YOU/);
  assert.match(result.text, /limit:/);
});

test("a small result is untouched, and not pretty-printed", async () => {
  const { surface } = fakeSurface();
  const { run } = fakeRunner(3);

  const { events } = await collect({
    surface,
    runQuery: run,
    stream: scripted([toolTurn("query", { malloy: "run: x -> { }" }), textTurn()]),
  });

  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(JSON.parse(result.text).rows.length, 3, "all three rows");
  assert.equal(result.text.includes("\n  "), false, "no indentation to pay for");
});
