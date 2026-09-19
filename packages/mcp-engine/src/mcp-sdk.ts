// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Optional adapter for hosts built on the official MCP server SDK
// (@modelcontextprotocol/server v2 — an optional peer dependency; only this
// subpath touches it). Tools register through McpServer.registerTool with
// `publishedSchema`, so the engine's JSON Schema descriptors go on the wire
// as-is — no zod, which is exactly the coupling the engine avoids.
//
// Caveats for hosts:
// - Pass `surface.instructions` to the server constructor yourself — the SDK
//   accepts instructions only at construction.

import {
  fromJsonSchema,
  type CallToolResult,
  type jsonSchemaValidator,
  type McpServer,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { toContent, type ToolSurface } from './surfaces/shared';

/** Accepts every input: the engine's handlers validate their own arguments. */
const PASS_THROUGH: jsonSchemaValidator = {
  getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
};

/**
 * A tool's JSON Schema for the SDK: published verbatim in tools/list, but NOT
 * enforced by the SDK before dispatch.
 *
 * The SDK would otherwise reject a call that fails the schema with a bare
 * "Input validation error". The engine is deliberately more forgiving than
 * its published schema (e.g. `query` resolves `source` from the Malloy text
 * when omitted) and reports what is wrong as problems[] data with a fix —
 * which only happens if the call reaches the handler.
 */
export function publishedSchema<T = Record<string, unknown>>(
  schema: Record<string, unknown>,
): StandardSchemaWithJSON<T, T> {
  return fromJsonSchema<T>(schema as never, PASS_THROUGH);
}

export interface AttachOptions {
  /** Also expose surface.skills as MCP prompts + resources. */
  registerSkillsAsPrompts?: boolean;
}

/** Attach a ToolSurface (and optionally its skills) to an SDK McpServer. */
export function attachSurface(
  server: McpServer,
  surface: ToolSurface,
  opts: AttachOptions = {},
): void {
  for (const tool of surface.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: publishedSchema(tool.inputSchema),
      },
      // Compile/run failures are data (problems[]), never protocol errors.
      async (args) => toContent(await tool.handler(args ?? {})) as CallToolResult,
    );
  }

  if (opts.registerSkillsAsPrompts) {
    for (const skill of surface.skills) {
      server.registerPrompt(
        skill.name,
        { title: skill.name, description: skill.description },
        () => ({
          messages: [
            { role: 'user' as const, content: { type: 'text' as const, text: skill.body } },
          ],
        }),
      );
      server.registerResource(
        skill.name,
        `malloy-skill://${skill.name}`,
        { title: skill.name, description: skill.description, mimeType: 'text/markdown' },
        async (uri: URL) => ({
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.body }],
        }),
      );
    }
  }
}
