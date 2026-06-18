// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// yo_help: a topic-indexed slice of the bundled Malloy language
// reference, plus engine-authored topics (restricted-queries) and folded-in
// skill content. Reachability rule: every piece of guidance must be
// reachable through yo_help, because it is the one channel every
// host has (the hosted endpoint has no prompts/resources capability).

import { contentFiles } from './content/generated';
import type { HelpTopic } from './types';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/** Markdown with optional YAML-ish front matter carrying `description:`. */
function parseFrontMatter(name: string, raw: string): ParsedSkill {
  // Strip the provenance HTML comment header if present.
  const withoutProvenance = raw.replace(/^<!--[\s\S]*?-->\s*\n/, '');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(withoutProvenance);
  if (!m) return { name, description: name, body: withoutProvenance };
  const d = /^description:\s*(.+)$/m.exec(m[1] ?? '');
  return {
    name,
    description: d?.[1]?.trim() ?? name,
    body: m[2] ?? '',
  };
}

/**
 * Parse the language reference into top-level `##` sections keyed by slug;
 * the preamble (before any ##) is indexed as "overview". Then append the
 * engine topics: each non-reference content file becomes one topic.
 */
function buildIndex(): HelpTopic[] {
  const topics: HelpTopic[] = [];

  const ref = contentFiles['malloy-language-reference.md'] ?? '';
  let current: HelpTopic = { slug: 'overview', title: 'Overview', body: '' };
  const bodyLines: string[] = [];
  const flush = () => {
    current.body = bodyLines.join('\n').trim();
    if (current.body) topics.push(current);
    bodyLines.length = 0;
  };
  for (const line of ref.split('\n')) {
    const m = /^## (?!# )(.+)$/.exec(line);
    if (m) {
      flush();
      const title = (m[1] ?? '').trim();
      current = { slug: slugify(title), title, body: '' };
      continue;
    }
    if (line.startsWith('---')) continue; // front matter fences
    if (/^<!--/.test(line) || /-->\s*$/.test(line)) continue; // provenance
    bodyLines.push(line);
  }
  flush();

  for (const [file, raw] of Object.entries(contentFiles)) {
    if (file === 'malloy-language-reference.md') continue;
    const name = file.replace(/\.md$/, '');
    const skill = parseFrontMatter(name, raw);
    topics.push({ slug: name, title: skill.description, body: skill.body.trim() });
  }

  return topics;
}

let cachedIndex: HelpTopic[] | null = null;
function index(): HelpTopic[] {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

export function listHelpTopics(): Array<{ slug: string; title: string }> {
  return index().map((t) => ({ slug: t.slug, title: t.title }));
}

/**
 * Lookup: exact slug → exact title (case-insensitive) → title/slug
 * substring → body tokens (every query word appears in the body). The body
 * fallback exists because agents ask for concepts by name ("count
 * distinct") that the reference explains inside a section without titling
 * it — observed on the first real fox run, where the miss nearly produced
 * a wrong measure.
 */
export function getHelpTopic(query: string): HelpTopic | undefined {
  const q = query.toLowerCase().trim();
  const all = index();
  const direct =
    all.find((t) => t.slug === q) ??
    all.find((t) => t.title.toLowerCase() === q) ??
    all.find((t) => t.title.toLowerCase().includes(q) || t.slug.includes(q));
  if (direct) return direct;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  return all.find((t) => {
    const body = t.body.toLowerCase();
    return tokens.every((tok) => body.includes(tok));
  });
}

/**
 * Map compiler error codes to a help topic slug, used to decorate
 * problems[] so errors tell the caller which doc section to pull.
 */
const ERROR_TOPIC_MAP: Record<string, string> = {
  'field-not-found': 'fields',
  'aggregate-in-calculate': 'expressions',
  'not-an-aggregate': 'fields',
  'mixed-reduction-projection': 'queries-and-views',
  'calculation-in-source': 'fields',
  'missing-aggregate-locality': 'aggregate-locality-symmetric-aggregates',
  'asymmetric-aggregate-needs-locality': 'aggregate-locality-symmetric-aggregates',
  'restricted-construct-forbidden': 'restricted-queries',
};

export function helpTopicForCode(code: string): string | undefined {
  return ERROR_TOPIC_MAP[code];
}

/** Skills the engine ships, as data; hosts decide how to expose them. */
export function engineSkills(): ParsedSkill[] {
  const raw = contentFiles['writing-malloy-with-mcp.md'];
  if (!raw) return [];
  return [parseFrontMatter('writing-malloy-with-mcp', raw)];
}
