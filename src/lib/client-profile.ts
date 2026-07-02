// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Per-client presentation policy, keyed off the request User-Agent. This is a
// HOST concern (the engine stays client-agnostic), so it lives here, not in
// mcp-engine. One place decides "who is this client and how should results be
// shaped for it" — no UA sniffing scattered around.
//
// Why it exists: some MCP clients read the tool result's `content` text well
// (claude.ai parses our pretty-printed JSON fine); others (ChatGPT, UA
// `openai-mcp/*`) file large tool results away as a retrieval document and then
// only surface a citation snippet — so a query's rows never reach the user, just
// the trailing `ltool_link` URL. For those clients we render the rows as a
// compact markdown TABLE in `content` instead, which they show inline.
//
// The invariant that protects working clients: `structuredContent` is IDENTICAL
// for every client. Only the human-facing `content` text varies by profile.

export type ClientProfile = {
  id: "chatgpt" | "default";
  /** Render an executed query's rows as a markdown table in `content` (vs the
      default pretty-printed JSON). */
  renderRowsInline: boolean;
  /** Include the `structuredContent` field on results. ChatGPT reads
      structuredContent when present and files it away as a retrieval document —
      surfacing only a citation snippet, so the rows never reach the user. For
      that client we OMIT structuredContent entirely, forcing everything through
      the `content` markdown table. Clients that parse structuredContent well
      (claude.ai) keep it. */
  sendStructuredContent: boolean;
};

const DEFAULT_PROFILE: ClientProfile = { id: "default", renderRowsInline: false, sendStructuredContent: true };

/** Map a request User-Agent to its presentation profile. Unknown/absent → the
    default (unchanged JSON behavior). */
export function clientProfile(userAgent: string | null | undefined): ClientProfile {
  if (userAgent && /^openai-mcp\b/i.test(userAgent)) {
    return { id: "chatgpt", renderRowsInline: true, sendStructuredContent: false };
  }
  return DEFAULT_PROFILE;
}

// How many rows to put in the inline table before we stop and point at the link.
// A giant table just recreates the "too big → filed away" problem we're solving;
// the full result always remains in structuredContent and behind the ltool link.
export const MAX_TABLE_ROWS = 50;

type QueryPayload = {
  rows?: unknown[];
  row_count?: number;
  rows_returned?: number;
  total_time_ms?: number;
  truncated?: { hint?: string } | undefined;
  ltool_link?: { text?: string; url?: string } | undefined;
  [k: string]: unknown;
};

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

/** A row is table-able only if all its values are scalars — Malloy `nest:`
    yields nested arrays/objects a flat table can't represent. */
function rowIsFlat(row: unknown): boolean {
  return !!row && typeof row === "object" && !Array.isArray(row) && Object.values(row as object).every(isScalar);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Escape the two characters that break a markdown table cell.
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Ordered union of keys across the shown rows (first-seen order preserves the
    query's column order; the union tolerates the rare non-uniform row). */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

function linkLine(link: QueryPayload["ltool_link"]): string | undefined {
  if (!link?.url) return undefined;
  return `[${link.text ?? "Open in browser"}](${link.url})`;
}

/** Render an executed-query payload as human-facing markdown: a rows table plus
    a footer (counts, truncation hint, share link). Falls back to compact
    single-line JSON when the rows can't be tabled (empty, or nested) — still far
    smaller than pretty-printed JSON, so it stays inline rather than being filed
    away. structuredContent (not this) remains the machine-readable channel. */
export function renderRowsMarkdown(payload: QueryPayload): string {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const link = linkLine(payload.ltool_link);

  // No rows, or any nested row → not tabl-able. Compact JSON keeps the data
  // present and small; append the link so it's never lost.
  if (rows.length === 0 || !rows.every(rowIsFlat)) {
    const json = JSON.stringify(payload);
    return link ? `${json}\n\n${link}` : json;
  }

  const flat = rows as Record<string, unknown>[];
  const shownRows = flat.slice(0, MAX_TABLE_ROWS);
  const cols = columnsOf(shownRows);

  const header = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = shownRows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`).join("\n");

  const total = payload.row_count ?? flat.length;
  const footerBits: string[] = [];
  footerBits.push(shownRows.length < total ? `Showing ${shownRows.length} of ${total} rows.` : `${total} row${total === 1 ? "" : "s"}.`);
  if (payload.truncated?.hint) footerBits.push(payload.truncated.hint);

  const parts = [`${header}\n${divider}\n${body}`, `_${footerBits.join(" ")}_`];
  if (link) parts.push(link);
  return parts.join("\n\n");
}
