// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The Ask loop, driven by a scripted model and a fake tool surface.
//
// What is worth pinning here is the part that is NOT the model: that a `query`
// call can never execute, that the answer is read off the model's own tool call
// rather than parsed out of prose, that a compile error gets another turn, and
// that a model which never converges stops at the cap instead of looping.

import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { User } from "@/db";
import type { HostedSurface, ToolResult } from "./mcp-host";
import { askCostUsd, askForMalloy, modelShape, supportsEffort, type AskDependencies } from "./ask";
import { formatMalloy } from "./format-malloy";

const USER = { id: "u1" } as User;

const INPUT = {
  user: USER,
  baseUrl: "https://example.test",
  source: "flights",
  dataset: "faa",
  question: "how many flights per carrier?",
};

/** Every turn reports the same token spend, so a test can multiply. */
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 10,
};

/** A model turn that calls `query` with this Malloy. */
function queryTurn(
  malloy: string,
  id = "t1",
  extra: Record<string, unknown> = {},
): Anthropic.Message {
  return {
    stop_reason: "tool_use",
    usage: USAGE,
    content: [
      {
        type: "tool_use",
        id,
        name: "query",
        input: { source: "flights", malloy, question: "per carrier", ...extra },
      },
    ],
  } as unknown as Anthropic.Message;
}

/** A model turn that just talks — the loop's terminal condition. */
function textTurn(text = "done"): Anthropic.Message {
  return {
    stop_reason: "end_turn",
    usage: USAGE,
    content: [{ type: "text", text }],
  } as unknown as Anthropic.Message;
}

/** A surface whose `query` compiles only the Malloy in `compiles`. Records
    every call so a test can assert on what the loop actually sent. */
function fakeSurface(compiles: (malloy: string) => boolean) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const surface: HostedSurface = {
    instructions: "INSTRUCTIONS",
    descriptors: [
      { name: "describe_source", description: "d", inputSchema: { type: "object" } },
      { name: "query", description: "q", inputSchema: { type: "object" } },
    ],
    async call(name, args): Promise<ToolResult> {
      calls.push({ name, args });
      const ok = name !== "query" || compiles(String(args.malloy ?? ""));
      return {
        content: [{ type: "text", text: ok ? "fine" : "'carier' is not a field" }],
        structuredContent: { ok },
      };
    },
  };
  return { surface, calls };
}

/** Play the given turns in order; fail loudly if the loop asks for more. */
function scriptedModel(turns: Anthropic.Message[]): AskDependencies["createMessage"] {
  let i = 0;
  return async () => {
    assert.ok(i < turns.length, "the loop asked for more turns than the script has");
    return turns[i++];
  };
}

test("returns the Malloy from the query call that compiled", async () => {
  const { surface } = fakeSurface(() => true);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([queryTurn("run: flights -> { group_by: carrier }"), textTurn()]),
  });

  assert.equal(result.ok, true);
  // Formatted on the way out — ltool shows this text in an editor.
  assert.equal(result.ok && result.malloy, "run: flights -> {\n  group_by: carrier\n}");
});

test("a one-line query comes back on newlines, however the model wrote it", async () => {
  const { surface } = fakeSurface(() => true);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      // What a model actually produces when nothing stops it: one line,
      // semicolons between the clauses. It compiles; it is not readable.
      queryTurn("run: flights -> { where: carrier = 'WN'; group_by: carrier; limit: 5 }"),
      textTurn(),
    ]),
  });

  assert.equal(
    result.ok && result.malloy,
    "run: flights -> {\n  where: carrier = 'WN'\n  group_by: carrier\n  limit: 5\n}",
  );
});

test("an executed query is capped, however many rows the model asks for", async () => {
  const { surface, calls } = fakeSurface(() => true);
  await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      queryTurn("run: flights -> { group_by: carrier }", "t1", { max_rows: 10_000 }),
      textTurn(),
    ]),
  });

  const queries = calls.filter((c) => c.name === "query");
  assert.equal(queries.length, 1);
  // The model may look at data — that is how it notices an empty result — but
  // it must not be able to pull a table into context.
  assert.equal(queries[0].args.max_rows, 50);
});

test("a validate-only call is left alone", async () => {
  const { surface, calls } = fakeSurface(() => true);
  await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      queryTurn("run: flights -> { group_by: carrier }", "t1", { execute: false }),
      textTurn(),
    ]),
  });

  const q = calls.find((c) => c.name === "query")!;
  assert.equal(q.args.execute, false);
  assert.equal(q.args.max_rows, undefined, "no cap is needed when nothing runs");
});

test("a query that does not compile gets another turn", async () => {
  const good = "run: flights -> { group_by: carrier }";
  const { surface, calls } = fakeSurface((m) => m === good);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      queryTurn("run: flights -> { group_by: carier }", "t1"),
      queryTurn(good, "t2"),
      textTurn(),
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.malloy, formatMalloy(good));
  assert.equal(calls.filter((c) => c.name === "query").length, 2);
});

test("the failing Malloy is not offered as the answer", async () => {
  const { surface } = fakeSurface(() => false);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([queryTurn("run: flights -> { group_by: carier }"), textTurn()]),
  });

  assert.equal(result.ok, false);
  // The problem the surface reported reaches the user, not a bare "gave up".
  assert.match(result.ok === false ? result.error : "", /carier/);
});

test("a model that never converges stops at the step cap", async () => {
  const { surface, calls } = fakeSurface(() => false);
  // Deliberately unbounded: the cap, not the script, has to end this.
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: async () => queryTurn("run: flights -> { group_by: carier }"),
  });

  assert.equal(result.ok, false);
  assert.ok(result.steps <= 6, `steps should be capped, got ${result.steps}`);
  assert.equal(calls.filter((c) => c.name === "query").length, result.steps);
});

test("a refusal ends the run without another turn", async () => {
  const { surface, calls } = fakeSurface(() => true);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      { stop_reason: "refusal", usage: USAGE, content: [] } as unknown as Anthropic.Message,
    ]),
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("a thrown tool handler is fed back rather than ending the run", async () => {
  const good = "run: flights -> { group_by: carrier }";
  let first = true;
  const surface: HostedSurface = {
    instructions: "INSTRUCTIONS",
    descriptors: [{ name: "query", description: "q", inputSchema: { type: "object" } }],
    async call(): Promise<ToolResult> {
      if (first) { first = false; throw new Error("model lease failed"); }
      return { content: [{ type: "text", text: "fine" }], structuredContent: { ok: true } };
    },
  };

  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([queryTurn("x", "t1"), queryTurn(good, "t2"), textTurn()]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.malloy, formatMalloy(good));
});

test("the assistant turn is echoed back whole, so thinking blocks survive", async () => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const { surface } = fakeSurface(() => true);
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const turn = {
    stop_reason: "tool_use",
    usage: USAGE,
    content: [thinking, { type: "tool_use", id: "t1", name: "query", input: { malloy: "m" } }],
  } as unknown as Anthropic.Message;

  await askForMalloy(INPUT, {
    surface,
    createMessage: async (params) => {
      seen.push(params);
      return seen.length === 1 ? turn : textTurn();
    },
  });

  const second = seen[1].messages.find((m) => m.role === "assistant");
  assert.ok(second, "the assistant turn must be replayed");
  assert.deepEqual(second.content, turn.content, "content must go back unchanged");
});

test("modelShape sends adaptive thinking and effort to the current generation", () => {
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-fable-5"]) {
    const shape = modelShape(model);
    assert.deepEqual(shape.thinking, { type: "adaptive" }, model);
    assert.equal(shape.output_config?.effort, "medium", model);
  }
});

test("modelShape sends neither to models that reject them", () => {
  // claude-haiku-4-5 400s on output_config.effort and does not take adaptive
  // thinking — the reason the branch exists at all.
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3-5-haiku-latest"]) {
    assert.deepEqual(modelShape(model), {}, model);
  }
});

test("usage is summed across every turn, cached input kept separate", async () => {
  const { surface } = fakeSurface(() => true);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([queryTurn("run: flights -> { group_by: carrier }"), textTurn()]),
  });

  // Two turns at USAGE each.
  assert.deepEqual(result.usage, { input: 200, cacheRead: 1800, cacheWrite: 20, output: 40 });
});

test("a failed ask still reports what it spent", async () => {
  const { surface } = fakeSurface(() => false);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([queryTurn("bad"), textTurn()]),
  });

  assert.equal(result.ok, false);
  assert.ok(result.usage.output > 0, "a failure that cost tokens must say so");
});

test("the asker's effort reaches the request", async () => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const { surface } = fakeSurface(() => true);
  await askForMalloy({ ...INPUT, effort: "low" }, {
    surface,
    createMessage: async (params) => { seen.push(params); return textTurn(); },
  });

  assert.equal(seen[0].output_config?.effort, "low");
});

test("an effort that is not on offer falls back to the default", async () => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const { surface } = fakeSurface(() => true);
  await askForMalloy({ ...INPUT, effort: "max" }, {
    surface,
    createMessage: async (params) => { seen.push(params); return textTurn(); },
  });

  assert.equal(seen[0].output_config?.effort, "medium");
});

test("a model the deployment does not offer never reaches the API", async () => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const { surface } = fakeSurface(() => true);
  // A hand-rolled request naming anything it likes must not be forwarded.
  const result = await askForMalloy({ ...INPUT, model: "some-other-vendor-model" }, {
    surface,
    createMessage: async (params) => { seen.push(params); return textTurn(); },
  });

  assert.notEqual(seen[0].model, "some-other-vendor-model");
  assert.equal(result.model, seen[0].model);
});

test("effort is reported as null for a model that takes none", async () => {
  assert.equal(supportsEffort("claude-haiku-4-5"), false);
  assert.equal(supportsEffort("claude-sonnet-5"), true);
});

test("cost weighs cached input at a tenth and cache writes above full rate", () => {
  // 1M uncached input on Sonnet is $3; the same tokens read from cache are $0.30.
  const rate = askCostUsd("claude-sonnet-5", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 });
  const cached = askCostUsd("claude-sonnet-5", { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 });
  const written = askCostUsd("claude-sonnet-5", { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 });
  assert.equal(rate, 3);
  assert.ok(Math.abs(cached! - 0.3) < 1e-9, `cached read should be a tenth, got ${cached}`);
  assert.ok(Math.abs(written! - 3.75) < 1e-9, `cache write should be 1.25x, got ${written}`);
});

test("a model with no published price reports no cost rather than zero", () => {
  assert.equal(askCostUsd("claude-something-unreleased", { input: 999, cacheRead: 0, cacheWrite: 0, output: 999 }), null);
});

test("the title comes from the model's synopsis of the winning query", async () => {
  const good = "run: flights -> { group_by: carrier }";
  const { surface } = fakeSurface((m) => m === good);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      // A rejected attempt carries its own synopsis; it must not win.
      queryTurn("bad", "t1", { question: "a wrong idea" }),
      queryTurn(good, "t2", { question: "Flights per carrier" }),
      textTurn(),
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.question, "Flights per carrier");
});

test("no synopsis means no title, so the caller falls back to what was typed", async () => {
  const { surface } = fakeSurface(() => true);
  const result = await askForMalloy(INPUT, {
    surface,
    createMessage: scriptedModel([
      queryTurn("run: flights -> { group_by: carrier }", "t1", { question: "  " }),
      textTurn(),
    ]),
  });

  assert.equal(result.ok && result.question, null);
});

test("a run whose surface reports ok is the answer, a failed one is not", async () => {
  // The loop reads structuredContent.ok to tell success from failure. Pinned
  // because that field is also governed by mcp-host's per-client presentation
  // policy: an in-app caller must always receive it (DEFAULT_CLIENT_PROFILE),
  // and if that ever stops being true every answer would read as a failure.
  const { surface } = fakeSurface(() => true);
  const noStructured: HostedSurface = {
    ...surface,
    async call(): Promise<ToolResult> {
      return { content: [{ type: "text", text: "rows" }] }; // no structuredContent
    },
  };

  const result = await askForMalloy(INPUT, {
    surface: noStructured,
    createMessage: scriptedModel([queryTurn("run: flights -> { group_by: carrier }"), textTurn()]),
  });

  assert.equal(result.ok, false, "without the ok signal nothing can be treated as an answer");
});

test("cost is an estimate the caller may withhold, never a required field", () => {
  // /api/ask omits costUsd for non-admins, so every consumer has to tolerate
  // its absence. askCostUsd already returns null for an unpriced model — this
  // pins that the two absences look the same to a reader.
  assert.equal(askCostUsd("claude-not-in-the-table", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }), null);
});
