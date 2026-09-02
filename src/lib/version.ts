// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The malloyyo version reported by the running server — in the MCP `initialize`
// handshake (serverInfo.version) and at /api/version. Single source of truth is
// this repo's root package.json (@malloyyo/server).
//
// ONE NUMBER covers the server and the published CLI (@malloydata/malloyyo):
// packages/cli/scripts/release.ts writes both on every merge to main. It used to
// keep them apart, reading the number as a compatibility claim; that left this
// one frozen at 0.2.31 through six CLI releases, so a running server could not
// say what code it was. It is an identity — if two deployments differ, their
// numbers differ — and compatibility comes from the server staying backward
// compatible, not from matching numbers.
//
// (The mcp-engine is an internal, unpublished library pinned at 0.0.1 and is
// deliberately NOT the version anyone means.)
//
// Importing the manifest is what makes the number real: it is compiled into the
// build, so a bumped manifest only reaches a deployment via a rebuild — which is
// exactly why the release commit must not carry [skip ci].
import { version } from "../../package.json";
import { env } from "./env";

export const VERSION: string = version;

/**
 * The commit the running build came from, abbreviated, or undefined.
 *
 * VERSION now moves on every merge, so it usually answers "is my deploy live?"
 * on its own. The commit still distinguishes two builds of the SAME version — a
 * rebuild of an unchanged tree, or an image composed elsewhere — which is the
 * remaining question an operator looking at an admin page might be asking.
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
