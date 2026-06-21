// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// yo_help: a topic-indexed slice of the bundled Malloy language reference, plus
// engine-authored how-to/policy topics and folded-in skill content. Topics live
// under content/help/** and are namespaced by directory (explore/, develop/,
// language/, …); a topic's NAME is its path (slug = path), and that one name is
// both what the index lists and what you pass back — there is no separate title.
//
// Reachability rule: every piece of guidance must be reachable through yo_help,
// because it is the one channel every host has (the hosted endpoint has no
// prompts/resources capability).

import { contentFiles } from './content/generated';
import type { HelpTopic } from './types';

/** Lowercase kebab a single path segment / heading. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A topic's name from its content key: drop `.md`, slugify each path segment.
    The path IS the name — one rule, always lowercase (so an exact-match lookup
    can never be defeated by a mis-cased filename). */
function nameFromKey(key: string): string {
  return key
    .replace(/\.md$/, '')
    .split('/')
    .map(slugify)
    .join('/');
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

// The ONE special-cased file: a vendored whole-doc language reference, split on
// its `## ` headings into per-concept topics under its own namespace (its
// directory → `language/`). Everything else is one file = one topic. If this is
// ever split into per-concept files, delete the branch — nothing else is special.
const LANGUAGE_REFERENCE = 'language/malloy-language-reference.md';

/** Split the language reference on `## ` headings into `<ns>/<heading>` topics;
    the preamble before the first heading becomes `<ns>/overview`. */
function splitReference(ns: string, raw: string, out: HelpTopic[]): void {
  let name = `${ns}/overview`;
  const bodyLines: string[] = [];
  const flush = (): void => {
    const body = bodyLines.join('\n').trim();
    if (body) out.push({ name, body });
    bodyLines.length = 0;
  };
  for (const line of raw.split('\n')) {
    const m = /^## (?!# )(.+)$/.exec(line);
    if (m) {
      flush();
      name = `${ns}/${slugify((m[1] ?? '').trim())}`;
      continue;
    }
    if (line.startsWith('---')) continue; // front-matter fences
    if (/^<!--/.test(line) || /-->\s*$/.test(line)) continue; // provenance
    bodyLines.push(line);
  }
  flush();
}

/** Build the topic index from the embedded content tree. One file → one topic
    (name = its path), except the language reference which fans out into sections. */
function buildIndex(): HelpTopic[] {
  const topics: HelpTopic[] = [];
  for (const [key, raw] of Object.entries(contentFiles)) {
    if (key === LANGUAGE_REFERENCE) {
      const ns = nameFromKey(key.replace(/\/[^/]+$/, '')); // its directory → "language"
      splitReference(ns, raw, topics);
    } else {
      topics.push({ name: nameFromKey(key), body: parseFrontMatter(key, raw).body.trim() });
    }
  }
  return topics;
}

let cachedIndex: HelpTopic[] | null = null;
function index(): HelpTopic[] {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

/** The index: one name per topic. Names ARE the identifier — pass one back to
    `getHelpTopic`/`yo_help` verbatim. */
export function listHelpTopics(): string[] {
  return index().map((t) => t.name);
}

/**
 * Resolve a topic. The contract is an exact name (case-insensitive — every name
 * is lowercase). The remaining rungs are forgiveness, not contract: a name
 * SUBSTRING (so a bare `joins` finds `language/joins`), then a body-token match
 * (so a concept asked for by phrase — "count distinct" — that isn't a topic name
 * still lands in the section that explains it).
 */
export function getHelpTopic(query: string): HelpTopic | undefined {
  const q = query.toLowerCase().trim();
  const all = index();
  const direct = all.find((t) => t.name === q) ?? all.find((t) => t.name.includes(q));
  if (direct) return direct;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  return all.find((t) => {
    const body = t.body.toLowerCase();
    return tokens.every((tok) => body.includes(tok));
  });
}

/**
 * Map compiler error codes to a help topic name, used to decorate problems[] so
 * errors tell the caller which doc to pull. Targets are full topic names.
 */
const ERROR_TOPIC_MAP: Record<string, string> = {
  'field-not-found': 'language/fields',
  'aggregate-in-calculate': 'language/expressions',
  'not-an-aggregate': 'language/fields',
  'mixed-reduction-projection': 'language/queries-and-views',
  'calculation-in-source': 'language/fields',
  'missing-aggregate-locality': 'language/aggregate-locality-symmetric-aggregates',
  'asymmetric-aggregate-needs-locality': 'language/aggregate-locality-symmetric-aggregates',
  'restricted-construct-forbidden': 'explore/restricted-queries',
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
