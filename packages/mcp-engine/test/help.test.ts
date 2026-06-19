import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  assembleInstructions,
  engineSkills,
  getHelpTopic,
  helpTopicForCode,
  listHelpTopics,
  guidance,
  renderInstructions,
  INSTANCE_PLACEHOLDER,
} from '../src/index';

const CONTENT_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'content');

/** All shipped content markdown (help topic bodies + the prompt tree). */
function contentMarkdown(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md') && name !== 'README.md') {
        out.push({ file: path.relative(CONTENT_DIR, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(CONTENT_DIR, 'help'));
  walk(path.join(CONTENT_DIR, 'prompts'));
  return out;
}

test('help: the index is one name per topic, and EVERY name resolves (reachability rule)', () => {
  const names = listHelpTopics();
  assert.ok(names.length > 5, `expected many topics, got ${names.length}`);
  assert.ok(
    names.every((n) => typeof n === 'string' && n.length > 0),
    'each topic is a single non-empty name (no {slug,title})',
  );
  // The language reference fans out, namespaced under its directory.
  assert.ok(names.includes('language/overview'), 'reference preamble → language/overview');
  assert.ok(names.includes('language/joins'), 'reference sections are namespaced under language/');
  // Generic reachability: every listed name resolves to itself, exactly. A
  // misfiled or mis-cased doc fails HERE rather than going dark in production.
  for (const n of names) {
    assert.equal(getHelpTopic(n)?.name, n, `exact round-trip for ${n}`);
  }
});

test('help: every yo_help("…") pointer in shipped content resolves to a real topic', () => {
  // The dual of the reachability rule: reachability proves every topic resolves
  // to itself; this proves every literal pointer in the content resolves to a
  // topic. Together they forbid orphan topics AND dangling pointers — the exact
  // drift class behind the renamed-file/shouty-keyword mess. Only literal
  // `yo_help("name")` calls are checked; `yo_help(help_topic)` (a variable) and
  // bare `yo_help()` are skipped.
  const re = /yo_help\("([^"]+)"\)/g;
  const misses: string[] = [];
  for (const { file, text } of contentMarkdown()) {
    for (const m of text.matchAll(re)) {
      const name = m[1]!;
      if (!getHelpTopic(name)) misses.push(`${file}: yo_help("${name}")`);
    }
  }
  assert.deepEqual(misses, [], `dangling yo_help pointer(s):\n${misses.join('\n')}`);
});

test('help: engine how-to / skill topics are reachable', () => {
  assert.ok(getHelpTopic('explore/restricted-queries'), 'restricted-queries topic exists (namespaced)');
  assert.ok(
    getHelpTopic('writing-malloy-with-mcp'),
    'skill content is reachable via yo_help, not only as a prompt',
  );
});

test('help: exact name is the contract; substring + case-insensitivity are forgiveness', () => {
  assert.equal(getHelpTopic('explore/restricted-queries')?.name, 'explore/restricted-queries');
  // a bare segment still finds its namespaced topic (forgiveness, not contract)
  assert.equal(getHelpTopic('restricted-queries')?.name, 'explore/restricted-queries');
  assert.equal(getHelpTopic('joins')?.name, 'language/joins');
  // case-insensitive
  assert.equal(getHelpTopic('EXPLORE/Restricted-Queries')?.name, 'explore/restricted-queries');
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
  assert.equal(helpTopicForCode('field-not-found'), 'language/fields');
  assert.equal(helpTopicForCode('restricted-construct-forbidden'), 'explore/restricted-queries');
  assert.equal(helpTopicForCode('no-such-code'), undefined);
  // The mapped names must be real topics — the pointer the agent gets must resolve.
  assert.ok(getHelpTopic('language/fields'));
  assert.ok(getHelpTopic('explore/restricted-queries'));
});

test('help: provenance comments do not leak into topic bodies', () => {
  const overview = getHelpTopic('language/overview');
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
  // restricted-queries is DELIBERATELY absent from the instructions: a proactive
  // "restricted mode" warning made client LLMs overcautious. The restriction is
  // surfaced REACTIVELY instead — the restricted-construct-forbidden error routes
  // to explore/restricted-queries (see the error-codes test). Do NOT add a
  // proactive mention back.
  assert.ok(guidance.explore.includes('explore/query-workflow'));
});

test("guidance: each surface's instructions fit the 2KB server-instructions cap", () => {
  // Claude Code truncates an MCP server's `instructions` at 2048 BYTES (utf-8) —
  // and the canon uses multi-byte em-dashes/arrows, so measure bytes, not chars.
  // Over the cap, the tail is silently dropped (the bug behind test-report-1).
  // Measure the RENDERED text (worst case: a long instance name), so the budget
  // accounts for what actually reaches the wire, not the shorter placeholder.
  const name = 'A Fairly Long Instance Name / Malloy';
  for (const kind of ['develop', 'explore'] as const) {
    const rendered = renderInstructions(assembleInstructions(kind), name);
    const bytes = Buffer.byteLength(rendered, 'utf8');
    assert.ok(bytes <= 2048, `${kind} instructions are ${bytes} bytes (cap 2048)`);
  }
});

test('renderInstructions: the host substitutes the instance name into the placeholder', () => {
  // The engine is instance-agnostic; the placeholder is how engine-authored
  // text names the instance, and the host renders it at serve time.
  assert.ok(
    guidance.explore.includes(INSTANCE_PLACEHOLDER),
    'explore instructions carry the instance placeholder for the host to fill',
  );
  const rendered = renderInstructions(assembleInstructions('explore'), 'World Cup / Malloy');
  assert.ok(rendered.includes('analytics for World Cup / Malloy'), 'name is substituted');
  assert.ok(
    !rendered.includes(INSTANCE_PLACEHOLDER),
    'no placeholder leaks to the wire once rendered',
  );
  // Idempotent / no-op when there is nothing to render.
  assert.equal(renderInstructions('plain text', 'X'), 'plain text');
});
