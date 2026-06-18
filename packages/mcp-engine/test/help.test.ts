import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleInstructions,
  engineSkills,
  getHelpTopic,
  helpTopicForCode,
  listHelpTopics,
  guidance,
} from '../src/index';

test('help: reference topics are indexed', () => {
  const topics = listHelpTopics();
  assert.ok(topics.length > 5, `expected many topics, got ${topics.length}`);
  assert.ok(topics.some((t) => t.slug === 'overview'));
});

test('help: engine topics are reachable (the reachability rule)', () => {
  assert.ok(getHelpTopic('restricted-queries'), 'restricted-queries topic exists');
  assert.ok(
    getHelpTopic('writing-malloy-with-mcp'),
    'skill content is reachable via yo_help, not only as a prompt',
  );
});

test('help: lookup by slug, title, and substring', () => {
  const bySlug = getHelpTopic('restricted-queries');
  assert.ok(bySlug);
  const bySub = getHelpTopic('restricted');
  assert.ok(bySub);
  assert.equal(getHelpTopic('zzz-no-such-topic'), undefined);
});

test('help: body-token fallback finds concepts not in any title', () => {
  // First-fox-run regression: "count distinct" is explained inside a
  // section body (count(expr) IS the distinct count in Malloy) but appears
  // in no topic title — the lookup must still land on it.
  const hit = getHelpTopic('count distinct');
  assert.ok(hit, 'count distinct resolves to a topic');
  assert.ok(hit.body.toLowerCase().includes('distinct'));
});

test('help: error codes map to topics', () => {
  assert.equal(helpTopicForCode('field-not-found'), 'fields');
  assert.equal(helpTopicForCode('restricted-construct-forbidden'), 'restricted-queries');
  assert.equal(helpTopicForCode('no-such-code'), undefined);
});

test('help: provenance comments do not leak into topic bodies', () => {
  const overview = getHelpTopic('overview');
  assert.ok(overview && !overview.body.includes('<!--'));
});

test('skills: writing-malloy ships as data with a description', () => {
  const skills = engineSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, 'writing-malloy-with-mcp');
  assert.ok(skills[0]?.description && skills[0].description !== skills[0].name);
  assert.ok(skills[0]?.body.length > 100);
});

test('guidance: canon blocks exist and carry the load-bearing rules', () => {
  assert.ok(guidance.core.includes('yo_help'));
  assert.ok(guidance.core.includes('top-N'));
  assert.ok(guidance.develop.includes('compile_file'));
  assert.ok(guidance.develop.includes('yo_help'));
  assert.ok(guidance.core.includes('restricted-queries'));
  assert.ok(guidance.explore.includes('MALLOYYO-QUERY-WORKFLOW'));
});

test("guidance: each surface's instructions fit the 2KB server-instructions cap", () => {
  // Claude Code truncates an MCP server's `instructions` at 2048 BYTES (utf-8) —
  // and the canon uses multi-byte em-dashes/arrows, so measure bytes, not chars.
  // Over the cap, the tail is silently dropped (the bug behind test-report-1).
  for (const kind of ['develop', 'explore'] as const) {
    const bytes = Buffer.byteLength(assembleInstructions(kind), 'utf8');
    assert.ok(bytes <= 2048, `${kind} instructions are ${bytes} bytes (cap 2048)`);
  }
});
