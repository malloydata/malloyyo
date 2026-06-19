// Turnkey surfaces over miniature hosts — the congruence layer.
// This PR ships and tests only the EXPLORE surface; developSurface stays in the
// engine as a dormant, general example (not exercised here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exploreSurface,
  mergeSurfaces,
  toContent,
  type SourceDescribeResult,
  type QueryValidationResult,
  type RunResult,
  type ToolSurface,
} from '../src/index';
import { testExploreHost } from './helpers';

function tool(surface: ToolSurface, name: string) {
  const t = surface.tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

test('surface construction does zero I/O', () => {
  // A host that explodes on any use — construction must still succeed.
  const explore = exploreSurface({ withModel: async () => { throw new Error('io!'); } });
  assert.ok(explore.tools.length > 0);
});

test('explore: list_sources registers only when host.list exists', () => {
  const without = exploreSurface(testExploreHost());
  assert.equal(without.tools.some((t) => t.name === 'list_sources'), false);
  const with_ = exploreSurface(testExploreHost({ withList: true }));
  assert.equal(with_.tools.some((t) => t.name === 'list_sources'), true);
});

test('explore: canonical tool set', () => {
  const s = exploreSurface(testExploreHost({ withList: true }));
  assert.deepEqual(
    s.tools.map((t) => t.name).sort(),
    ['describe_source', 'list_sources', 'query', 'yo_help'],
  );
});

test('explore: describe_source returns the source + join closure, source text but no develop-only coords', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'describe_source').handler({
    model_ref: 'flights.malloy',
    source: 'flights',
  })) as SourceDescribeResult;
  assert.equal(result.ok, true);
  assert.equal(result.source, 'flights');
  // The requested source plus the sources its joins reach.
  assert.deepEqual(Object.keys(result.sources ?? {}).sort(), ['carriers', 'flights']);
  const text = JSON.stringify(result.sources);
  // Block 1 (the JSON `sources`) is the structured digest: no develop-only
  // coordinate and no raw source text — both are stripped.
  assert.ok(!text.includes('"location"'), 'no develop-only location coords in block 1');
  assert.ok(!text.includes('"body"'), 'no raw source text in block 1');
  // Block 2 (`malloy_text`) is the verbatim source — requested + closure.
  const malloy = result.malloy_text ?? '';
  assert.match(malloy, /source: flights is/, 'block 2 carries the requested source verbatim');
  assert.match(malloy, /join_one: carriers is carriers with carrier/, 'join keys ride in the source text');
  assert.match(malloy, /source: carriers is/, 'block 2 includes the joined (closure) source');
});

test('explore: two-channel annotations + descriptive relationship', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'describe_source').handler({
    model_ref: 'flights.malloy',
    source: 'flights',
  })) as SourceDescribeResult;
  assert.equal(result.ok, true);
  const flights = result.sources!['flights']!;
  // `#"` → description, `#(agent)` → instructions: two distinct channels.
  assert.equal(flights.description, 'Flight facts, with nested route legs and free-form tags.');
  assert.equal(flights.instructions, 'Grain is one row per flight; join carriers for airline names.');
  const total = flights.measures.find((m) => m.name === 'total_distance');
  assert.equal(total?.instructions, 'Sum across flights; do not average a pre-summed value.');
  // promoted routes (doc + agent) are stripped from annotations[] (not double-sent).
  assert.equal(flights.annotations, undefined);
  // descriptive relationship name (join_one → many_to_one).
  const carriers = flights.joins.find((j) => j.name === 'carriers');
  assert.equal(carriers?.relationship, 'many_to_one');
});

test('explore: describe_source on unknown source lists what exists', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'describe_source').handler({
    model_ref: 'flights.malloy',
    source: 'nope',
  })) as SourceDescribeResult;
  assert.equal(result.ok, false);
  const p = result.problems.find((x) => x.code === 'source-not-found');
  assert.ok(p?.message.includes('flights'));
});

test('explore: describe_source without a source is a clean problem', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'describe_source').handler({
    model_ref: 'flights.malloy',
  })) as SourceDescribeResult;
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.code, 'source-required');
});

test('explore: unknown ref refuses with model-not-found, not a throw', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'describe_source').handler({
    model_ref: 'nope.malloy',
    source: 'flights',
  })) as SourceDescribeResult;
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.code, 'model-not-found');
});

test('explore: a bare reference with no catalog is a clean problem', async () => {
  // No host.list → a bare source cannot be resolved; guide toward list_sources
  // rather than falling through to the host (an empty path would EISDIR).
  const s = exploreSurface(testExploreHost());
  const q = (await tool(s, 'query').handler({ malloy: 'run: x' })) as RunResult;
  assert.equal(q.ok, false);
  assert.equal(q.problems[0]?.code, 'model-ref-required');
  assert.match(q.problems[0]?.message ?? '', /list_sources/);

  const d = (await tool(s, 'describe_source').handler({})) as SourceDescribeResult;
  assert.equal(d.ok, false);
  assert.equal(d.problems[0]?.code, 'source-required');
});

test('explore: query execute:false validates and reports givens', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'query').handler({
    model_ref: 'givens_model.malloy',
    malloy: 'run: above_target',
    execute: false,
  })) as QueryValidationResult;
  assert.equal(result.ok, true);
  assert.equal(result.givens?.[0]?.name, 'TARGET');
  assert.equal(typeof result.sql, 'string', 'execute:false returns the generated SQL');
});

test('explore: query executes restricted text with givens', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'query').handler({
    model_ref: 'givens_model.malloy',
    malloy: 'run: above_target',
    givens: { TARGET: 3 },
  })) as RunResult;
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(result.rows, [{ v: 3 }]);
  assert.equal(result.sql, undefined, 'execute:true does not carry SQL (output, not input)');
});

test('explore: query rejects forbidden constructs', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'query').handler({
    model_ref: 'flights.malloy',
    malloy: 'run: duckdb.sql("SELECT 1 as x") -> { select: x }',
  })) as RunResult;
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === 'restricted-construct-forbidden'));
});

test('explore: an error result carries inline help (help-on-error)', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'query').handler({
    model_ref: 'flights.malloy',
    malloy: 'run: duckdb.sql("SELECT 1 as x") -> { select: x }',
  })) as RunResult & { help?: Array<{ slug: string; title: string; body: string }> };
  assert.equal(result.ok, false);
  assert.ok(result.help && result.help.length > 0, 'help bodies attached to the error');
  assert.ok(result.help!.every((h) => h.body.length > 0), 'each help entry carries content');
});

test('explore: field-not-found is nudged toward describe_source', async () => {
  const s = exploreSurface(testExploreHost());
  const result = (await tool(s, 'query').handler({
    model_ref: 'flights.malloy',
    source: 'flights',
    malloy: 'run: flights -> { aggregate: not_real }',
  })) as RunResult;
  assert.equal(result.ok, false);
  const p = result.problems.find((x) => x.code === 'field-not-found');
  assert.ok(p?.message.includes('describe_source'));
});

test('explore: list_sources returns the catalog hierarchy', async () => {
  const s = exploreSurface(testExploreHost({ withList: true }));
  const result = (await tool(s, 'list_sources').handler({})) as {
    ok: boolean;
    models: Array<{ model_ref: string }>;
  };
  assert.equal(result.ok, true);
  assert.ok(result.models.some((m) => m.model_ref === 'flights.malloy'));
});

test('yo_help: shared tool answers topics and lists them', async () => {
  const s = exploreSurface(testExploreHost());
  const list = (await tool(s, 'yo_help').handler({})) as {
    topics: Array<{ slug: string }>;
  };
  assert.ok(list.topics.length > 5);
  const topic = (await tool(s, 'yo_help').handler({
    topic: 'restricted-queries',
  })) as { slug: string; body: string };
  assert.equal(topic.slug, 'restricted-queries');
});

test('mergeSurfaces: dedupes identical tools across surfaces', () => {
  // Two explore surfaces share identical query + yo_help definitions → dedupe.
  const merged = mergeSurfaces(
    exploreSurface(testExploreHost({ withList: true })),
    exploreSurface(testExploreHost({ withList: true })),
  );
  const names = merged.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  assert.equal(names.filter((n) => n === 'query').length, 1);
  assert.equal(names.filter((n) => n === 'yo_help').length, 1);
});

test('mergeSurfaces: a real name collision throws at construction', () => {
  const a = exploreSurface(testExploreHost());
  const clash: ToolSurface = {
    tools: [{ ...a.tools[0]!, description: 'something different' }],
    instructions: '',
    skills: [],
  };
  assert.throws(() => mergeSurfaces(a, clash), /collision/);
});

test('toContent: serializes typed results to MCP content + structuredContent', () => {
  const out = toContent({ ok: true, rows: [1] });
  assert.equal(out.content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(out.content[0]!.text), { ok: true, rows: [1] });
  assert.deepEqual(out.structuredContent, { ok: true, rows: [1] });
});
