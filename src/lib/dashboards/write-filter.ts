// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The explorer's tier-2 filter help on the HOSTED app: a description → a
// Malloy filter expression, written by the deployment's Ask model and
// validated by the real parser before it reaches the frame. The prompt and
// answer contract are the engine's (`writeFilterPrompt` /
// `parseWriteFilterAnswer`); the dev server has the same host half in
// packages/cli/src/write-filter.ts. Enabled exactly when Ask is (one key).

import Anthropic from "@anthropic-ai/sdk";
import {
  BooleanFilterExpression,
  NumberFilterExpression,
  StringFilterExpression,
  TemporalFilterExpression,
} from "@malloydata/malloy-filter";
import { parseWriteFilterAnswer, writeFilterPrompt, type WriteFilterRequest } from "@malloyyo/mcp-engine";
import { env } from "@/lib/env";

export type WriteFilterResult =
  | { ok: true; text: string; note?: string }
  | { ok: false; error: string; note?: string };

export function filterParses(type: string, text: string): boolean {
  const P =
    type === "number" ? NumberFilterExpression
    : type === "boolean" ? BooleanFilterExpression
    : type === "date" || type === "timestamp" || type === "timestamptz" ? TemporalFilterExpression
    : StringFilterExpression;
  const r = P.parse(text);
  return r.parsed !== null && !(r.log ?? []).some((l) => l.severity === "error");
}

export async function writeFilter(
  req: WriteFilterRequest,
  callModel: (system: string, user: string) => Promise<string> = defaultCallModel,
): Promise<WriteFilterResult> {
  const description = (req.description ?? "").trim();
  if (!description) return { ok: false, error: "nothing to write a filter from" };
  const { system, user } = writeFilterPrompt({ ...req, today: req.today ?? new Date().toISOString().slice(0, 10) });
  let raw: string;
  try {
    raw = await callModel(system, user);
  } catch (e) {
    return { ok: false, error: `filter help unavailable: ${(e as Error).message}` };
  }
  const answer = parseWriteFilterAnswer(raw);
  if (!answer.text) return { ok: false, error: answer.note || "that can't be said as a filter expression", note: answer.note };
  if (!filterParses(req.type, answer.text)) {
    return { ok: false, error: `the suggested filter doesn't parse: ${answer.text}`, note: answer.note };
  }
  return { ok: true, text: answer.text, note: answer.note };
}

async function defaultCallModel(system: string, user: string): Promise<string> {
  const workspace = env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
  });
  const msg = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: user }],
  });
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
