// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Optional adapter for @modelcontextprotocol/sdk hosts (the SDK is an
// optional peer dependency; only this subpath touches it). Tools register
// through the LOW-LEVEL request handlers, where tool definitions are plain
// JSON — the engine's JSON Schema descriptors are the wire format already.
// (The high-level registerTool path is zod-only, which is exactly the
// coupling the engine avoids.)
//
// Caveats for hosts:
// - Pass `surface.instructions` to the server constructor yourself — the SDK
//   accepts instructions only at construction.
// - Declare the `tools` capability (and `prompts`/`resources` when
//   registering skills) at construction.
// - Do not mix this with McpServer.registerTool on the same server: both
//   want the tools/list and tools/call handlers.

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toContent, type ToolSurface } from './surfaces/shared';

export interface AttachOptions {
  /** Also expose surface.skills as MCP prompts + resources (McpServer only). */
  registerSkillsAsPrompts?: boolean;
}

function lowLevel(server: Server | McpServer): Server {
  return 'server' in server ? (server as McpServer).server : (server as Server);
}

/**
 * Attach a ToolSurface to an SDK server. Accepts the high-level McpServer
 * (so skills can register as prompts/resources) or the low-level Server.
 */
export function attachSurface(
  server: Server | McpServer,
  surface: ToolSurface,
  opts: AttachOptions = {},
): void {
  const s = lowLevel(server);
  const byName = new Map(surface.tools.map((t) => [t.name, t]));

  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: surface.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
    })),
  }));

  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    // Compile/run failures are data (problems[]), never protocol errors.
    const result = await tool.handler(
      (req.params.arguments ?? {}) as Record<string, unknown>,
    );
    return toContent(result);
  });

  if (opts.registerSkillsAsPrompts && 'registerPrompt' in server) {
    const mcp = server as McpServer;
    for (const skill of surface.skills) {
      mcp.registerPrompt(
        skill.name,
        { title: skill.name, description: skill.description },
        () => ({
          messages: [
            { role: 'user' as const, content: { type: 'text' as const, text: skill.body } },
          ],
        }),
      );
      mcp.registerResource(
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
