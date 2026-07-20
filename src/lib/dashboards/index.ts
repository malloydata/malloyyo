// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The page-safe dashboard surface. `@/lib/dashboards` re-exports ONLY the
// DB-only ./meta helpers, so importing this barrel never drags Malloy/DuckDB
// into the importer's graph — a Next PAGE can import it freely. The Malloy /
// DuckDB query + introspection work is deliberately NOT re-exported here: import
// it from `@/lib/dashboards/engine` (API routes only). That explicit `/engine`
// path is the signal that a module needs the native lib and must never sit in a
// page's SSR graph. See ./meta, ./engine, and reference_ssr_page_duckdb_500.

export * from "./meta";
