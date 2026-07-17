// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Model-contributed guidance: a published model may ship its OWN help topics —
// domain rulings, vocabulary, canonical patterns — as markdown files under
// `guidance/` in the model directory, alongside index.malloy. They travel with
// the model (publish/refresh ingest them like any model file) and are served
// through yo_help, the one guidance channel every host has (see
// docs/explore-surface.md "Delivery model").
//
// The naming rule is help.ts's: the topic name IS the file path (slugged,
// `.md` dropped) — `guidance/sales.md` → `guidance/sales`. A host serving
// several models prefixes a namespace (its model_ref) so two models' topics
// can't collide; yo_help's substring rung still resolves the short name.

import type { HelpTopic } from './types';

/** A model-contributed topic: a HelpTopic plus the one-line description its
    front matter carries (used to index it in instructions and catalogs). */
export interface GuidanceTopic extends HelpTopic {
  description?: string;
}

const GUIDANCE_DIR = 'guidance/';

/** Lowercase-kebab one path segment — the same rule help.ts applies. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function nameFromPath(path: string): string {
  return path
    .replace(/\.md$/, '')
    .split('/')
    .map(slugify)
    .join('/');
}

/** Markdown with optional YAML-ish front matter carrying `description:`. */
function parseTopic(name: string, raw: string): GuidanceTopic {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return { name, body: raw.trim() };
  const d = /^description:\s*(.+)$/m.exec(m[1] ?? '');
  const topic: GuidanceTopic = { name, body: (m[2] ?? '').trim() };
  const description = d?.[1]?.trim();
  if (description) topic.description = description;
  return topic;
}

/**
 * The guidance topics a model's file set contributes: every `guidance/**\/*.md`
 * in `files` (path → content, as publish stores them), named by path. A
 * `namespace` (a host's model_ref) prefixes every name — pass one whenever the
 * serving host offers more than one model.
 */
export function modelGuidanceTopics(
  files: Iterable<[string, string]>,
  namespace?: string,
): GuidanceTopic[] {
  const topics: GuidanceTopic[] = [];
  const prefix = namespace ? `${slugify(namespace)}/` : '';
  for (const [path, content] of files) {
    if (!path.startsWith(GUIDANCE_DIR) || !path.endsWith('.md')) continue;
    topics.push(parseTopic(prefix + nameFromPath(path), content));
  }
  return topics.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The instructions lead-block announcing a model's guidance: the topic index
 * with each one-line description, and the read-first rule. Kept to one line
 * per topic — instructions are a capped, best-effort channel; the topics
 * themselves ride yo_help.
 */
export function guidanceInstructionsBlock(topics: GuidanceTopic[]): string {
  if (topics.length === 0) return '';
  const lines = topics.map(
    (t) => `- \`${t.name}\`${t.description ? ` — ${t.description}` : ''}`,
  );
  return (
    'This model publishes its own guidance — domain rules that change the numbers. ' +
    'Read the relevant topic with yo_help BEFORE writing a query:\n' +
    lines.join('\n')
  );
}
