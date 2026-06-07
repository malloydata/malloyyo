import { customAlphabet } from "nanoid";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
import { env } from "./env";

// Heroku-style friendly slug for the user-facing MCP path. ~525k combos
// (≈1500 adjectives × ≈350 animals) — plenty of headroom while we have
// only a single-tenant v0. When real auth lands, the slug stops being
// the security boundary and friendliness wins outright.
export function newUserSlug(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
    style: "lowerCase",
  });
}

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
