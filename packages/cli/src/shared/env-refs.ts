// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// malloy-config.json can hold secrets by reference: `"password": { "env": "PG_PW" }`.
// Malloy resolves an UNSET reference to empty rather than failing, so the symptom
// is a baffling connection error — "connect ECONNREFUSED", "password
// authentication failed" — that never mentions the variable. Both the CLI (this
// shell) and the push route (that deployment) check for it and say the name.

/** `{"env": "NAME"}` references in `configJson` with no value in `env`. Deduped. */
export function missingEnvRefs(
  configJson: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!configJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return []; // Malloy reports the bad JSON itself.
  }
  const missing = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.env === "string" && !env[rec.env]) missing.add(rec.env);
    for (const v of Object.values(rec)) walk(v);
  };
  walk(parsed);
  return [...missing];
}

/** One-line-per-var explanation, or "" when nothing is missing. `where` names
    the environment the check ran against ("this shell", a server URL). */
export function missingEnvHint(missing: string[], where: string): string {
  if (missing.length === 0) return "";
  const vars = missing.map((v) => `$${v}`).join(", ");
  const isAre = missing.length > 1 ? "are" : "is";
  return (
    `\n  malloy-config.json references ${vars}, which ${isAre} NOT set on ${where}.` +
    `\n  Malloy reads an unset reference as an empty value, which usually shows up as` +
    `\n  the connection error above.`
  );
}
