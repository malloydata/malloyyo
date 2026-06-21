// End-to-end: spawn the built `malloyyo mcp` stdio server over the engine's
// fixture model and drive it with raw JSON-RPC. Proves the CLI host wires the
// shared engine exploreSurface correctly — list_sources, describe_source, and
// query (execute:true → rows/no-SQL; execute:false → SQL/no-rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'index.js');
const FIXTURES = path.join(here, '..', '..', 'mcp-engine', 'test', 'fixtures');

interface RpcResponse {
  id?: number;
  result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> };
  error?: unknown;
}

/** Send a batch of JSON-RPC messages over stdio, end stdin (the server exits on
    EOF), and return responses keyed by id. */
async function rpc(requests: object[]): Promise<Map<number, RpcResponse>> {
  const child = spawn('node', [CLI, 'mcp', '-C', FIXTURES], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { out += d; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { err += d; });
  for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
  child.stdin.end();
  const code = await new Promise<number>((resolve, reject) => {
    child.on('exit', (c) => resolve(c ?? 0));
    child.on('error', reject);
  });
  assert.equal(code, 0, `server exited ${code}; stderr: ${err}`);
  const byId = new Map<number, RpcResponse>();
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const m = JSON.parse(s) as RpcResponse;
    if (typeof m.id === 'number') byId.set(m.id, m);
  }
  assert.ok(byId.size > 0, `no responses; stderr: ${err}`);
  return byId;
}

const json = (r: RpcResponse): Record<string, unknown> =>
  JSON.parse(r.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;

test('malloyyo mcp: explore surface over stdio, end to end', async () => {
  const res = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sources', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'describe_source', arguments: { source: 'managers' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query', arguments: { source: 'managers', malloy: 'run: managers -> { aggregate: c is count() }' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'query', arguments: { source: 'managers', malloy: 'run: managers -> { select: name }', execute: false } } },
  ]);

  // The source-centric tool set.
  const tools = (res.get(2)!.result!.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(tools, ['describe_source', 'list_sources', 'query', 'yo_help']);

  // list_sources — catalog hierarchy. Models are keyed by model_ref, each
  // model's sources keyed by source_ref. `managers` is defined+exported in
  // index.malloy; `people` is imported (not top-level) so it is NOT listed.
  const list = json(res.get(3)!) as { ok: boolean; models: Record<string, { sources?: Record<string, unknown> }> };
  assert.equal(list.ok, true);
  const idx = list.models['index.malloy'];
  assert.ok(idx?.sources && 'managers' in idx.sources, 'managers listed');
  assert.ok(!(idx?.sources && 'people' in idx.sources), 'imported people not top-level');

  // describe_source — block 0 digest (resolved a BARE source) + block 1 source.
  // The described source rides in `described_source`, with dimensions keyed by name.
  const desc = res.get(4)!;
  const digest = JSON.parse(desc.result!.content![0]!.text) as {
    ok: boolean; source: string;
    described_source: { name: string; dimensions: Record<string, { type: string }> };
  };
  assert.equal(digest.ok, true);
  assert.equal(digest.source, 'managers');
  assert.equal(digest.described_source.name, 'managers');
  assert.ok('role' in digest.described_source.dimensions, 'role dimension present');
  assert.match(desc.result!.content![1]!.text, /source: managers is/);

  // query execute:true → rows, NO sql.
  const run = json(res.get(5)!) as { ok: boolean; rows: unknown[]; sql?: string };
  assert.equal(run.ok, true);
  assert.deepEqual(run.rows, [{ c: 1 }]);
  assert.equal(run.sql, undefined, 'execute:true carries no SQL');

  // query execute:false → SQL, no rows.
  const val = json(res.get(6)!) as { ok: boolean; sql?: string; rows?: unknown[] };
  assert.equal(val.ok, true);
  assert.equal(typeof val.sql, 'string', 'execute:false returns SQL');
  assert.equal(val.rows, undefined, 'execute:false does not run');
});
