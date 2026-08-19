// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { customAlphabet } from "nanoid";
import { env } from "./env";

// Users used to get a Heroku-style slug here ("muddy-platypus"), because the MCP
// endpoint lived at /mcp/<slug> and an unguessable path was standing in for
// authentication on a single-tenant v0. That comment ended "when real auth lands,
// the slug stops being the security boundary and friendliness wins outright" —
// real auth landed, /mcp identifies the caller from the token, and nothing read
// the slug afterwards. It was still minted on every sign-in and still shown in
// the hosted Members table, where it meant nothing to anyone.
//
// The column went with it (drizzle/0014_drop_user_slug.sql).

// Random URL-safe id, lowercase, no ambiguous chars. Reserved for future
// per-dataset identifiers if we need them; datasets currently address by
// their `name` field.
const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
export const newDatasetSlug = customAlphabet(alphabet, 10);

// Shareable query slug: <instance-code>_<random>. The instance prefix lets a
// slug minted on one deployment be detected (and rejected with a helpful
// pointer) when it's handed to a different deployment's tools.
export function instanceSlug(): string {
  return `${env.INSTANCE_CODE}_${newDatasetSlug()}`;
}

// Split a slug into its instance prefix and the random tail. Returns null for
// legacy/un-prefixed slugs. `matchesInstance` is true when the prefix is this
// deployment's INSTANCE_CODE.
export function parseSlug(slug: string): { code: string; matchesInstance: boolean } | null {
  const i = slug.indexOf("_");
  if (i <= 0) return null;
  const code = slug.slice(0, i).toLowerCase();
  return { code, matchesInstance: code === env.INSTANCE_CODE };
}

export function nameToSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "dataset"
  );
}
