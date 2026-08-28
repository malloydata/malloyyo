// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The malloyyo version reported by the running server — in the MCP `initialize`
// handshake (serverInfo.version) and at /api/version. Single source of truth is
// this repo's root package.json (@malloyyo/server).
//
// This is the SERVER's version and only the server's. The published CLI
// (@malloydata/malloyyo) carries its own: packages/cli/scripts/release.ts
// deliberately does not mirror one into the other, because a server is deployed
// on its own schedule and a globally installed CLI is upgraded on the
// operator's — a CLI patch that moved this number would report every deployment
// as out of date. Compatibility across that gap comes from the server staying
// backward compatible, not from matching numbers.
//
// (The mcp-engine is an internal, unpublished library pinned at 0.0.1 and is
// deliberately NOT the version anyone means.)
//
// Importing the manifest keeps this honest: bump the root package.json and
// everything the server reports follows — no hand-edited literal to drift.
import { version } from "../../package.json";
import { env } from "./env";

export const VERSION: string = version;

/**
 * The commit the running build came from, abbreviated, or undefined.
 *
 * VERSION alone does not answer "is my deploy live?". The release workflow
 * deliberately does not move the repo-root @malloyyo/server version — see the
 * note above, and packages/cli/scripts/release.ts — so it changes only when
 * someone bumps it by hand, and many deploys share one number. The commit is
 * what actually distinguishes two deployments of the same version, which is the
 * question an operator looking at an admin page is asking.
 *
 * Seven characters: git's own abbreviation, unambiguous in a repo this size and
 * readable at a glance.
 *
 * A function, not a const: a module-scope constant would capture process.env at
 * import time, which is both untestable and a trap if anything ever loads this
 * before the environment is populated.
 */
export function shortSha(): string | undefined {
  return env.BUILD_SHA?.slice(0, 7);
}

/** VERSION, plus the commit when there is one: `0.2.31 · 064c6b5`. The admin
    header is the only caller today; it lives here rather than inline in the
    layout so a second surface (an /api/version field, a footer) gets the same
    string instead of inventing its own spelling. */
export function buildLabel(): string {
  const sha = shortSha();
  return sha ? `${VERSION} \u00b7 ${sha}` : VERSION;
}
