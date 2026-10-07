// A host's raw run reply → what runQuery/useQuery hand a component.
//
// Hosts differ in shape: the dev server relays the engine's RunResult
// (`stable_result`, `truncated: { reason, hint }`, `problems`), the hosted app
// its own (`stableResult`, `truncated: boolean`, `error`), and a static site
// builds its reply in the page (staticRunReply below). Pure, so it can be
// tested without React or a browser.
export interface RunMessage {
  ok: boolean;
  rows: unknown[];
  result: unknown;
  /** True when the result hit the host's row limit (5,000), so `rows` may be
      a prefix of the full answer. */
  truncated: boolean;
  error?: string;
}

export function normalizeRunMessage(m: Record<string, any>): RunMessage {
  return {
    ok: !!m.ok,
    rows: m.rows || [],
    result: m.stable_result ?? m.stableResult,
    truncated: !!m.truncated,
    error: m.ok
      ? undefined
      : String(m.error ?? (m.problems || []).map((p: { message: string }) => p.message).join("; ") ?? "query failed"),
  };
}

/** A static site's reply (frame-wasm-entry.tsx), in the dev server's shape.
    Hitting the row limit is the only sign rows were cut — the engine's own rule
    (mcp-engine/src/run.ts) — so a full page of rows reads as truncated. */
export function staticRunReply(rows: unknown[], stableResult: unknown, rowLimit: number) {
  return { ok: true, rows, stable_result: stableResult, truncated: rows.length >= rowLimit };
}
