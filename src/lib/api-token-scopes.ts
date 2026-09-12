// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What an API token may reach. Its own module, with no imports, because both
// the database schema and a client component need it — and pulling the schema
// into the browser bundle to read two strings would be silly.
//
// A union rather than a pgEnum: adding a scope should be data, not a migration.
export const API_TOKEN_SCOPES = ["publish", "mcp"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
