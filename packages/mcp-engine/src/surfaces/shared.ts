// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Turnkey plumbing shared by both surfaces: the tools-as-data contract,
// serialization, merging, argument coercion, and the shared yo_help
// tool. Handlers return TYPED results (never MCP content blocks); hosts
// decorate by mapping over the records and serialize via toContent.

import { getHelpTopic, listHelpTopics, engineSkills } from '../help';
import { prompts } from '../prompts';
import type { HelpTopic, Problem, RunResult } from '../types';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Plain JSON Schema — the MCP wire format, usable verbatim by any host. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<object>;
}

export interface ToolSurface {
  tools: ToolDef[];
  instructions: string;
  skills: Array<{ name: string; description: string; body: string }>;
}

export interface SpillContext {
  toolName: string;
  args: unknown;
}

export interface ResultPolicy {
  /** Serialized-rows byte budget per response. Default 25_000. */
  maxResultBytes?: number;
  /** Describe budget; defaults to maxResultBytes. */
  maxDescribeBytes?: number;
  /** Persist the full result, return a reference for truncated.full_result. */
  spill?: (
    full: RunResult,
    ctx: SpillContext,
  ) => Promise<{ uri: string; note?: string } | undefined>;
}

export const DEFAULT_RESULT_BYTES = 25_000;

/** Serializer: typed result → MCP content + structuredContent. Two reserved
    fields are special-cased:
    - `malloy_text` is lifted OUT into its own clean text block (verbatim Malloy)
      so code is never escaped inside the JSON block, and removed from the
      JSON/structuredContent so it isn't double-sent.
    - `host_only` is DROPPED entirely (no block, not serialized). It carries data
      the surface produced for the HOST but deliberately withholds from the agent
      (e.g. the SQL of an executed run — recorded by the host, never shown). The
      host reads it off the raw result before serializing; every other consumer
      (the CLI's attachSurface, structuredContent) never sees it. */
export function toContent(result: object): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const { malloy_text, host_only: _host_only, ...rest } =
    result as { malloy_text?: unknown; host_only?: unknown };
  const content: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: JSON.stringify(rest, null, 2) },
  ];
  if (typeof malloy_text === 'string' && malloy_text.length > 0) {
    content.push({ type: 'text', text: malloy_text });
  }
  return { content, structuredContent: { ...rest } as Record<string, unknown> };
}

/**
 * Concatenate surfaces; dedupe tools whose name AND definition match (the
 * shared yo_help); an accidental collision of same-name different
 * tools throws at construction rather than shadowing.
 */
export function mergeSurfaces(...surfaces: ToolSurface[]): ToolSurface {
  const tools = new Map<string, ToolDef>();
  const skills = new Map<string, ToolSurface['skills'][number]>();
  const instructions: string[] = [];
  for (const s of surfaces) {
    for (const t of s.tools) {
      const existing = tools.get(t.name);
      if (existing) {
        const same =
          existing.description === t.description &&
          JSON.stringify(existing.inputSchema) === JSON.stringify(t.inputSchema);
        if (!same) {
          throw new Error(
            `mergeSurfaces: tool name collision on '${t.name}' with differing definitions`,
          );
        }
        continue;
      }
      tools.set(t.name, t);
    }
    for (const sk of s.skills) skills.set(sk.name, sk);
    if (s.instructions && !instructions.includes(s.instructions)) {
      instructions.push(s.instructions);
    }
  }
  return {
    tools: [...tools.values()],
    skills: [...skills.values()],
    instructions: instructions.join('\n\n'),
  };
}

// ── defensive argument coercion (no validator dependency by design) ──

export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return v === undefined || v === null ? '' : String(v);
}

export function argOptString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

export function argOptNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function argOptBool(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return v === true || v === 'true';
}

export function argRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = args[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

// ── the shared yo_help tool ──────────────────────────────────

export function yoHelpTool(): ToolDef {
  return {
    name: 'yo_help',
    title: prompts.shared.tools.yo_help.title,
    description: prompts.shared.tools.yo_help.description,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Topic slug or title (case-insensitive; substrings match). ' +
            'Omit to list all available topics.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const topic = argOptString(args, 'topic');
      if (!topic) return { topics: listHelpTopics() };
      const hit = getHelpTopic(topic);
      if (!hit) {
        return { error: `No topic matches '${topic}'.`, topics: listHelpTopics() };
      }
      return { slug: hit.slug, title: hit.title, body: hit.body };
    },
  };
}

export function sharedSkills(): ToolSurface['skills'] {
  return engineSkills();
}

// ── help-on-error: inline the fix, don't just point at it ────────────
//
// problems[] carry a `help_topic` POINTER. The deployed lesson is that the
// result-echo is the most reliable channel — the client re-reads the tool
// result every turn — and that agents don't reliably choose to fetch help.
// So resolve the distinct help_topics to their full bodies and attach them as
// `help` on the result. The agent gets the actual fix where it's already
// looking, without a second yo_help round trip. No-op when there are no
// problems or none carry a topic (so success results are untouched).

function attachHelp<T extends object>(result: T): T {
  const problems = (result as { problems?: Problem[] }).problems;
  if (!Array.isArray(problems) || problems.length === 0) return result;
  const help: HelpTopic[] = [];
  const seen = new Set<string>();
  for (const p of problems) {
    if (!p.help_topic || seen.has(p.help_topic)) continue;
    seen.add(p.help_topic);
    const hit = getHelpTopic(p.help_topic);
    if (hit) help.push(hit);
  }
  return help.length ? { ...result, help } : result;
}

/** Wrap a tool so its result carries inline `help` for any help_topic'd
    problem. Applied once per surface; a no-op for results without problems. */
export function withHelp(tool: ToolDef): ToolDef {
  return { ...tool, handler: async (args) => attachHelp(await tool.handler(args)) };
}
