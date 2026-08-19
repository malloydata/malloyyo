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

export const VERSION: string = version;
