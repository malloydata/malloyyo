// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * WHY A PUBLISH FAILED TO COMPILE, in terms the publisher can act on.
 *
 * Shared by both publish routes — the repo push and the older dataset push —
 * so "which secret isn't set here" reads the same whichever one a CLI reached.
 */

export type FailureKind = "missing-import" | "connection" | "compile";

// Best-effort: an unresolved import surfaces as an error mentioning a file URL that
// isn't in the uploaded set; a connection problem names the connection or fails at
// connect time. The CLI turns `kind` into a next step — "which file didn't upload"
// and "which secret isn't set here" are very different fixes from "fix the Malloy".
export function classifyCompileError(error: string, paths: Set<string>, missingEnv: string[]): FailureKind {
  for (const m of error.matchAll(/file:\/\/\/([^\s'"]+)/g)) {
    if (!paths.has(m[1])) return "missing-import";
  }
  if (missingEnv.length > 0) return "connection";
  if (/No connection named|Invalid SQL, (connect |getaddrinfo|Error: connect)/i.test(error)) {
    return "connection";
  }
  return "compile";
}

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
