#!/usr/bin/env node
// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// malloyyo_client — the same MCP tools the server serves, run locally against a
// compiled model, so an agent can conjure and debug a query without a round
// trip and send it only once it knows the query compiles.
//
// Commands ARE the MCP tools: every subcommand below is dispatched into the
// engine's `exploreSurface` tool array, the identical objects the hosted /mcp
// endpoint exposes. Nothing here reimplements list_sources or describe_source,
// so the two surfaces cannot drift into lookalikes that disagree.
//
// The one deliberate divergence: `query` is compile-only. Rows live where the
// data lives; the client's job is to prove a query is VALID (and show its SQL)
// so the trip to the server is the last step rather than the debugging loop.

import { exploreSurface, type ToolDef } from '@malloyyo/mcp-engine';
import { version as VERSION } from '../package.json';
import { ClientError, openModelFile, type LoadedModel } from './model.js';

const USAGE = `malloyyo_client ${VERSION} — offline Malloy query compiler

  Compile and debug queries against a model fetched from a Malloyyo instance.
  Get the model with the \`fetch_compiled_model\` MCP tool (write its blob to a
  file), or locally with \`malloyyo compile -o model.json\`.

USAGE
  malloyyo_client --model <file> <command> [args]

COMMANDS
  list_sources                     the models and sources this file publishes
  describe_source <source>         a source's fields, measures, views, joins
  query <source> <malloy>          compile a query: SQL + problems (never runs it)
  yo_help [topic]                  Malloy authoring help; omit topic to list
  info                             what this model file is, and its versions

OPTIONS
  -m, --model <file>   compiled model blob ('-' for stdin) [env MALLOYYO_MODEL]
      --givens <json>  values for $NAME givens, e.g. '{"STATE":"CA"}'
      --model-ref <r>  disambiguate when a source name is not unique
      --compact        single-line JSON (default is indented)
      --any-version    DEV ONLY: open a blob whose Malloy version differs from
                       this build's, warning instead of refusing. For testing
                       both halves from one working tree; a mismatch in the wild
                       means the model cannot be read correctly.
                       [env MALLOYYO_ANY_VERSION=1]
  -h, --help           this message
  -v, --version        print the version

EXIT STATUS
  0  ok        1  the request failed (see .problems)      2  usage or load error

Queries are compile-only here. Once one compiles, run it on the server with the
\`query\` MCP tool to get rows.`;

interface Parsed {
  command?: string;
  positionals: string[];
  model?: string;
  givens?: string;
  modelRef?: string;
  compact: boolean;
  anyVersion: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    positionals: [],
    compact: false,
    anyVersion: process.env['MALLOYYO_ANY_VERSION'] === '1',
    help: false,
    version: false,
  };
  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '-m': case '--model': out.model = need(a, argv[++i]); break;
      case '--givens': out.givens = need(a, argv[++i]); break;
      case '--model-ref': case '--model_ref': out.modelRef = need(a, argv[++i]); break;
      case '--compact': out.compact = true; break;
      case '--any-version': out.anyVersion = true; break;
      case '-h': case '--help': out.help = true; break;
      case '-v': case '--version': out.version = true; break;
      default: {
        // `--flag=value` and the long forms of the above.
        const eq = a.startsWith('--') ? a.indexOf('=') : -1;
        if (eq > 0) {
          const [k, v] = [a.slice(0, eq), a.slice(eq + 1)];
          if (k === '--model' || k === '-m') { out.model = v; break; }
          if (k === '--givens') { out.givens = v; break; }
          if (k === '--model-ref' || k === '--model_ref') { out.modelRef = v; break; }
          throw new UsageError(`unknown option '${k}'`);
        }
        if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option '${a}'`);
        if (out.command === undefined) out.command = a;
        else out.positionals.push(a);
      }
    }
  }
  return out;
}

/** Map a subcommand + its positionals onto the MCP tool's argument object. */
function toolArgs(cmd: string, p: Parsed, loaded: LoadedModel): Record<string, unknown> {
  const modelRef = p.modelRef ?? loaded.blob.model_ref;
  const givens = (): Record<string, unknown> | undefined => {
    if (p.givens === undefined) return undefined;
    try {
      const v: unknown = JSON.parse(p.givens);
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('expected a JSON object');
      }
      return v as Record<string, unknown>;
    } catch (e) {
      throw new UsageError(`--givens must be a JSON object: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  switch (cmd) {
    case 'list_sources':
      return {};
    case 'describe_source': {
      const source = p.positionals[0];
      if (!source) throw new UsageError('describe_source needs a source name');
      return { source, model_ref: modelRef };
    }
    case 'query': {
      const [source, malloy] = p.positionals;
      if (!source || !malloy) {
        throw new UsageError("query needs a source and query text, e.g. query orders 'run: orders -> { aggregate: c is count() }'");
      }
      // Compile-only, always: the client has no data. `execute` is not an
      // option we accept rather than one we silently ignore.
      const args: Record<string, unknown> = { source, malloy, model_ref: modelRef, execute: false };
      const g = givens();
      if (g) args['givens'] = g;
      return args;
    }
    case 'yo_help': {
      const topic = p.positionals[0];
      return topic ? { topic } : {};
    }
    default:
      throw new UsageError(`unknown command '${cmd}'`);
  }
}

function emit(value: unknown, compact: boolean): void {
  process.stdout.write((compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n');
}

/** ok:false anywhere in a tool result means the request failed. */
function failed(result: object): boolean {
  return (result as { ok?: unknown }).ok === false || 'error' in result;
}

async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv);
  if (p.version) { process.stdout.write(VERSION + '\n'); return 0; }
  // Asking for help is a success; being invoked with nothing is not.
  if (p.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (!p.command) { process.stderr.write(USAGE + '\n'); return 2; }

  const modelPath = p.model ?? process.env['MALLOYYO_MODEL'];
  if (!modelPath) {
    throw new UsageError(
      'no model file. Pass --model <file> (or set MALLOYYO_MODEL).\n' +
        'Get one from the `fetch_compiled_model` MCP tool, or `malloyyo compile -o model.json`.',
    );
  }

  const loaded = openModelFile(modelPath, { allowVersionMismatch: p.anyVersion });

  if (p.command === 'info') {
    const b = loaded.blob;
    emit({
      ok: true,
      model_ref: b.model_ref,
      malloy_version: b.malloy_version,
      client_version: b.client_version,
      running_client: VERSION,
      model_bytes: b.bytes,
      blob_bytes: b.payload.length,
    }, p.compact);
    return 0;
  }

  const tools = exploreSurface(loaded.host).tools;
  const tool: ToolDef | undefined = tools.find((t) => t.name === p.command);
  if (!tool) {
    throw new UsageError(
      `unknown command '${p.command}'. Available: ${[...tools.map((t) => t.name), 'info'].join(', ')}`,
    );
  }

  const result = await tool.handler(toolArgs(tool.name, p, loaded));
  emit(result, p.compact);
  return failed(result) ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`malloyyo_client: ${e.message}\n\nTry --help.\n`);
      process.exitCode = 2;
      return;
    }
    if (e instanceof ClientError) {
      process.stderr.write(`malloyyo_client: ${e.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`malloyyo_client: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 2;
  },
);
