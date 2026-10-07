// A host's raw run reply → what runQuery / useQuery hand a component.
//
// Hosts differ in shape: the dev server relays the engine's RunResult
// (`stable_result`, `problems[]`), the hosted app its own (`stableResult`,
// `error`), and a static site builds a dev-server-shaped reply in the page
// (frame-wasm-entry.tsx). All three carry the engine's row-limit notice as
// `truncated: { reason, hint }` when the cap cut the rows. Pure, so it is
// tested without React or a browser.

export interface Truncation {
  reason: string;
  /** Guidance for whoever wrote the query: aggregate / filter / top-N in Malloy. */
  hint: string;
}

export interface RunMessage {
  ok: boolean;
  rows: unknown[];
  result: unknown;
  /** The host's row limit cut the result, so `rows` may be a prefix of the
      answer. null when nothing was cut. */
  truncated: Truncation | null;
  error?: string;
}

export function normalizeRunMessage(m: Record<string, any>): RunMessage {
  const t = m.truncated;
  return {
    ok: !!m.ok,
    rows: m.rows || [],
    result: m.stable_result ?? m.stableResult,
    truncated: t && typeof t === "object" && typeof t.hint === "string" ? { reason: String(t.reason), hint: t.hint } : null,
    error: m.ok
      ? undefined
      : String(m.error ?? (m.problems || []).map((p: { message: string }) => p.message).join("; ") ?? "query failed"),
  };
}

/** What a person viewing the dashboard reads when a result was cut. The hint
    is for the author; this is for the viewer, who cannot change the query. */
export function truncationNote(rowCount: number): string {
  return `Showing the first ${rowCount.toLocaleString("en-US")} rows; more may exist.`;
}
