// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The develop surface: build a model. Per the fox plan (brain
// mcp-fox-mode/develop-server.md): the SAME query tool explore has —
// pointed at a root model file via ref = path — plus compile-and-inspect
// entry points for an agent writing .malloy files. The old open toolset
// (run/run_file/list_runs) is gone from the turnkey surface: query subsumes
// execution, runs are visible in compile output, and compile_file IS
// describe here. (The helpers remain exported for custom compositions,
// e.g. malloy-cli's open mode when it adopts the engine.)
//
// Tool titles + descriptions are prose, edited in content/prompts/**.md and
// read here via `prompts` (see src/prompts.ts) — NOT inlined. They stay to one
// or two lines, each tool owning a distinct concept word: long descriptions
// DILUTE the client's tool-search ranking (deployed lesson, malloyyo
// src/lib/mcp-tools.ts). Behavioral policy belongs in the surface instructions
// (content/prompts/develop/instructions.md), never in descriptions.

import { compile } from '../walker';
import { prettify } from '../prettify';
import { assembleInstructions } from '../guidance';
import { prompts } from '../prompts';
import { errorProblem } from '../problems';
import type { SourceInput } from '../prepare-source';
import type { Problem } from '../types';
import type { BoundModel, ExploreHost } from './explore';
import { queryTool } from './explore';
import {
  argOptBool,
  argOptString,
  argString,
  yoHelpTool,
  withHelp,
  sharedSkills,
  type ResultPolicy,
  type ToolDef,
  type ToolSurface,
} from './shared';

export interface DevelopHost {
  /**
   * Lease a runtime for one call over the given input. Typical impl:
   * prepareSource(baseReader, input) → new Runtime(...) → fn → finally
   * idle/close. Throw to refuse (e.g. path outside the project root).
   */
  withRuntime<T>(input: SourceInput, fn: (m: BoundModel) => Promise<T>): Promise<T>;
}

export interface DevelopSurfaceOptions {
  result?: ResultPolicy;
}

const pathSchema = {
  type: 'string',
  description:
    'Path to a .malloy file, relative to the server root. (Absolute paths ' +
    'and file:// URIs are also accepted.)',
};
const sourceSchema = { type: 'string', description: 'Malloy source code.' };
const basePathSchema = {
  type: 'string',
  description:
    'Optional path for resolving relative imports in the inline source — ' +
    'typically the file the snippet will live next to. If omitted, imports ' +
    'must be absolute.',
};
const expandSchema = {
  type: 'string',
  enum: ['ref', 'inline'],
  description:
    "Join rendering: 'ref' (default) references joined sources by name via " +
    "source_ref; 'inline' recursively inlines the joined schema.",
};
const emitRunSqlSchema = {
  type: 'boolean',
  description:
    'Compile each run: statement to SQL and include it as model.runs[].sql. ' +
    'Default false (large; use query to execute).',
};

export function developSurface(
  host: DevelopHost,
  opts: DevelopSurfaceOptions = {},
): ToolSurface {
  async function lease<T>(
    input: SourceInput,
    fn: (m: BoundModel) => Promise<T>,
  ): Promise<T | { ok: false; problems: Problem[] }> {
    try {
      return await host.withRuntime(input, fn);
    } catch (e) {
      return { ok: false, problems: [errorProblem(e)] };
    }
  }

  // The query tool runs over the same lease: a model ref here IS a path.
  const modelHost: Pick<ExploreHost, 'withModel'> = {
    withModel: (ref, fn) => host.withRuntime({ url: ref }, fn),
  };

  const tools: ToolDef[] = [
    {
      name: 'compile_file',
      title: prompts.develop.tools.compile_file.title,
      description: prompts.develop.tools.compile_file.description,
      inputSchema: {
        type: 'object',
        properties: { path: pathSchema, expand: expandSchema, emit_run_sql: emitRunSqlSchema },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args) =>
        lease({ url: argString(args, 'path') }, (m) =>
          compile(m.runtime, m.entry, {
            readSource: m.readSource,
            expand: argOptString(args, 'expand') as 'ref' | 'inline' | undefined,
            emitRunSql: argOptBool(args, 'emit_run_sql'),
          }),
        ),
    },
    {
      name: 'compile',
      title: prompts.develop.tools.compile.title,
      description: prompts.develop.tools.compile.description,
      inputSchema: {
        type: 'object',
        properties: {
          source: sourceSchema,
          base_path: basePathSchema,
          expand: expandSchema,
          emit_run_sql: emitRunSqlSchema,
        },
        required: ['source'],
        additionalProperties: false,
      },
      handler: async (args) =>
        lease(
          { source: argString(args, 'source'), baseUrl: argOptString(args, 'base_path') },
          (m) =>
            compile(m.runtime, m.entry, {
              readSource: m.readSource,
              expand: argOptString(args, 'expand') as 'ref' | 'inline' | undefined,
              emitRunSql: argOptBool(args, 'emit_run_sql'),
            }),
        ),
    },
    queryTool(modelHost, {
      result: opts.result,
      inspect: { tool: 'compile_file', param: 'path' },
    }),
    {
      name: 'prettify',
      title: prompts.develop.tools.prettify.title,
      description: prompts.develop.tools.prettify.description,
      inputSchema: {
        type: 'object',
        properties: { source: sourceSchema },
        required: ['source'],
        additionalProperties: false,
      },
      handler: async (args) => prettify(argString(args, 'source')),
    },
    yoHelpTool(),
  ];

  return {
    tools: tools.map(withHelp),
    instructions: assembleInstructions('develop'),
    skills: sharedSkills(),
  };
}
