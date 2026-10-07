// The explorer's tier-2 filter help: a description the user typed that is NOT
// a filter expression → one, written by a model that has the filter-language
// reference. The prompt and the answer contract live in the engine
// (`writeFilterPrompt` / `parseWriteFilterAnswer`); this file is the dev
// server's HOST half: the model call (plain fetch — the CLI carries no SDK) and
// the validation gate (the real parser from `@malloydata/malloy-filter`), so
// what reaches the frame is either a filter that parses or a problem.
//
// Enabled by `ANTHROPIC_API_KEY` in the dev server's environment; without it
// the explorer stays tier-1 only (the box flags unparseable text) and the UI
// shows no "write it for me" affordance.

import {
  BooleanFilterExpression,
  NumberFilterExpression,
  StringFilterExpression,
  TemporalFilterExpression,
} from "@malloydata/malloy-filter";
import {
  parseWriteFilterAnswer,
  writeFilterPrompt,
  type WriteFilterRequest,
} from "@malloyyo/mcp-engine";

export type WriteFilterResult =
  | { ok: true; text: string; note?: string }
  | { ok: false; error: string; note?: string };

const DEFAULT_MODEL = "claude-haiku-4-5";

export function writeFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ANTHROPIC_API_KEY ?? "").length > 0;
}

/** Does `text` parse as a filter over `type`? Mirrors the frame's
    `filters.isValid` so server and client agree on tier 1. */
export function filterParses(type: string, text: string): boolean {
  const P =
    type === "number" ? NumberFilterExpression
    : type === "boolean" ? BooleanFilterExpression
    : type === "date" || type === "timestamp" || type === "timestamptz" ? TemporalFilterExpression
    : StringFilterExpression;
  const r = P.parse(text);
  return r.parsed !== null && !(r.log ?? []).some((l) => l.severity === "error");
}

/** Call the model. `callModel` is injectable for tests; the default posts to
    the Anthropic Messages API. */
export async function writeFilter(
  req: WriteFilterRequest,
  opts: {
    env?: NodeJS.ProcessEnv;
    callModel?: (system: string, user: string) => Promise<string>;
  } = {},
): Promise<WriteFilterResult> {
  const env = opts.env ?? process.env;
  const description = (req.description ?? "").trim();
  if (!description) return { ok: false, error: "nothing to write a filter from" };
  // No tier-1 shortcut here: for a STRING field every text parses (as an
  // equality — "west coast" is the legal filter `= 'west coast'`), so a user
  // who clicked "write it" wants the description INTERPRETED, not echoed. Tier
  // 1 is the client's call, made before it ever asks.
  const call = opts.callModel ?? ((system, user) => anthropicMessages(env, system, user));
  const { system, user } = writeFilterPrompt({
    ...req,
    today: req.today ?? new Date().toISOString().slice(0, 10),
  });
  let raw: string;
  try {
    raw = await call(system, user);
  } catch (e) {
    return { ok: false, error: `filter help unavailable: ${(e as Error).message}` };
  }
  const answer = parseWriteFilterAnswer(raw);
  if (!answer.text) {
    return { ok: false, error: answer.note || "that can't be said as a filter expression", note: answer.note };
  }
  if (!filterParses(req.type, answer.text)) {
    return {
      ok: false,
      error: `the suggested filter doesn't parse: ${answer.text}`,
      note: answer.note,
    };
  }
  return { ok: true, text: answer.text, note: answer.note };
}

async function anthropicMessages(env: NodeJS.ProcessEnv, system: string, user: string): Promise<string> {
  const key = env.ANTHROPIC_API_KEY ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}
