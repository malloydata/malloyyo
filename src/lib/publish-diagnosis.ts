// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * WHY A PUBLISH FAILED TO COMPILE, in terms the publisher can act on.
 *
 * A config's `{"env": …}` secret that is unset here never shows up in Malloy's
 * own error — the connection just fails — so it is looked for explicitly.
 */

/**
 * Env vars that malloy-config.json references as `{"env": "NAME"}` but that
 * aren't set HERE. Malloy resolves a missing one to empty rather than failing,
 * so the symptom is a baffling connection error ("connect ECONNREFUSED",
 * "password authentication failed") with no mention of the secret. The config
 * ships from the repo but the values are per-deployment, so this is the single
 * likeliest reason a model that works locally fails on publish.
 *
 * The CLI runs the same check against its own shell before sending
 * (packages/cli/src/shared/env-refs.ts) — separate package, so it's duplicated.
 */
export function missingEnvRefs(configJson: string | undefined): string[] {
  if (!configJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return []; // Malloy will report the bad JSON itself.
  }
  const missing = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.env === "string" && !process.env[rec.env]) missing.add(rec.env);
    for (const v of Object.values(rec)) walk(v);
  };
  walk(parsed);
  return [...missing];
}
