// End-to-end proof of the optional SDK adapter: a real SDK client talks to a
// real SDK server over the in-memory transport, with the engine's EXPLORE
// surface attached through the low-level handlers (raw JSON Schema, no zod).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { attachSurface } from '../src/mcp-sdk';
import { exploreSurface } from '../src/index';
import { testExploreHost } from './helpers';

async function connectedPair() {
  const surface = exploreSurface(testExploreHost({ withList: true }));
  const server = new McpServer(
    { name: 'engine-test', version: '0.0.0' },
    {
      instructions: surface.instructions,
      capabilities: { tools: {}, prompts: {}, resources: {} },
    },
  );
  attachSurface(server, surface, { registerSkillsAsPrompts: true });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test('sdk adapter: tools/list exposes the surface with JSON Schema', async () => {
  const { client, server } = await connectedPair();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['describe_source', 'list_sources', 'query', 'yo_help']);
    const query = tools.find((t) => t.name === 'query');
    assert.equal(query?.inputSchema.type, 'object');
    assert.ok((query?.inputSchema.properties as Record<string, unknown>)['malloy']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('sdk adapter: tools/call round-trips a real describe and a real query', async () => {
  const { client, server } = await connectedPair();
  try {
    const described = await client.callTool({
      name: 'describe_source',
      arguments: { model_ref: 'flights.malloy', source: 'flights' },
    });
    const describedResult = described.structuredContent as { ok: boolean };
    assert.equal(describedResult.ok, true);

    const ran = await client.callTool({
      name: 'query',
      arguments: { model_ref: 'flights.malloy', malloy: 'run: top_carriers' },
    });
    const runResult = ran.structuredContent as { ok: boolean; rows: unknown[] };
    assert.equal(runResult.ok, true);
    assert.equal(runResult.rows.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test('sdk adapter: failures are problems data, unknown tools are isError', async () => {
  const { client, server } = await connectedPair();
  try {
    const bad = await client.callTool({
      name: 'query',
      arguments: { model_ref: 'flights.malloy', malloy: 'import "x"\nrun: top_carriers' },
    });
    assert.notEqual(bad.isError, true, 'compile failures are data, not protocol errors');
    const result = bad.structuredContent as { ok: boolean; problems: Array<{ code: string }> };
    assert.equal(result.ok, false);
    assert.equal(result.problems[0]?.code, 'restricted-construct-forbidden');

    const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
    assert.equal(unknown.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('sdk adapter: skills register as prompts and resources', async () => {
  const { client, server } = await connectedPair();
  try {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'writing-malloy-with-mcp'));
    const prompt = await client.getPrompt({ name: 'writing-malloy-with-mcp' });
    const first = prompt.messages[0]?.content;
    assert.equal(first?.type, 'text');
    assert.ok((first as { text: string }).text.length > 100);

    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === 'malloy-skill://writing-malloy-with-mcp'));
  } finally {
    await client.close();
    await server.close();
  }
});
