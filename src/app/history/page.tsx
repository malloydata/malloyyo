"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const MalloyCodeEditor = dynamic(
  () => import("@/components/MalloyCodeEditor").then((m) => m.MalloyCodeEditor),
  { ssr: false, loading: () => <div className="h-32 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900" /> },
);

type HistoryItem = {
  inquiryId: string;
  question: string;
  createdAt: string;
  source: string | null;
  datasetId: string | null;
  malloyQuery: string | null;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
};

type RunResult = {
  rows: Record<string, unknown>[];
  sql: string;
  row_count: number;
  truncated: boolean;
  duration_ms: number;
};

export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, []);

  const runQuery = useCallback(async (src: string, malloy: string) => {
    if (!src || !malloy.trim()) return;
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: src, malloy }),
      });
      const json = await res.json();
      if (!res.ok) {
        setRunError(json.error ?? "query failed");
      } else {
        setResult(json);
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  function selectItem(item: HistoryItem) {
    setSelected(item);
    setQuery(item.malloyQuery ?? "");
    setSource(item.source ?? "");
    setResult(null);
    setRunError(null);
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    if (item.malloyQuery && item.source) {
      runQuery(item.source, item.malloyQuery);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 font-mono text-sm space-y-6">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← home</Link>
        <h1 className="text-xl font-bold mt-2">Query history</h1>
      </header>

      <section>
        {loading ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">loading…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">No queries yet. Ask Claude a question via the MCP server.</p>
        ) : (
          <ul className="border border-gray-200 dark:border-gray-800 rounded divide-y divide-gray-100 dark:divide-gray-900">
            {items.map((item) => (
              <li key={item.inquiryId}>
                <button
                  onClick={() => selectItem(item)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors ${selected?.inquiryId === item.inquiryId ? "bg-blue-50 dark:bg-blue-950/30" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 dark:text-gray-200 truncate">{item.question}</p>
                      <div className="flex items-center gap-3 mt-1">
                        {item.source && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                            {item.source}
                          </span>
                        )}
                        {item.malloyQuery && !item.source && (
                          <span className="text-xs text-gray-400 dark:text-gray-600 truncate max-w-xs">
                            {item.malloyQuery.split("\n")[0]}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-400 dark:text-gray-600">
                      {item.rowCount != null && (
                        <span>{item.rowCount.toLocaleString()} rows</span>
                      )}
                      {item.durationMs != null && (
                        <span>{(item.durationMs / 1000).toFixed(1)}s</span>
                      )}
                      {item.error && (
                        <span className="text-red-500 dark:text-red-400">error</span>
                      )}
                      <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section ref={detailRef} className="space-y-4 border-t border-gray-200 dark:border-gray-800 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Question</p>
              <p className="text-gray-800 dark:text-gray-200">{selected.question}</p>
            </div>
            {source && (
              <span className="flex-shrink-0 text-xs px-2 py-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                {source}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Malloy query</p>
            <MalloyCodeEditor value={query} onChange={setQuery} minHeight="120px" />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => runQuery(source, query)}
              disabled={running || !source || !query.trim()}
              className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
            >
              {running ? "running…" : "Run"}
            </button>
            {result && !running && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {result.row_count.toLocaleString()} rows · {(result.duration_ms / 1000).toFixed(2)}s
                {result.truncated && " · truncated"}
              </span>
            )}
          </div>

          {runError && (
            <pre className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 whitespace-pre-wrap">
              {runError}
            </pre>
          )}

          {result && (
            <div className="space-y-2">
              <ResultTable rows={result.rows} />
              <details className="text-xs">
                <summary className="text-gray-400 dark:text-gray-600 cursor-pointer hover:text-gray-600 dark:hover:text-gray-400">
                  SQL
                </summary>
                <pre className="mt-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded p-3 overflow-auto whitespace-pre text-[11px] text-gray-600 dark:text-gray-400">
                  {result.sql}
                </pre>
              </details>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function formatCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-gray-300 dark:text-gray-700">—</span>;
  }
  if (typeof value === "boolean") {
    return <span className={value ? "text-green-700 dark:text-green-400" : "text-gray-400"}>{String(value)}</span>;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (Array.isArray(value)) {
    return (
      <span className="text-gray-500 dark:text-gray-400 italic">
        [{value.length} rows]
      </span>
    );
  }
  if (typeof value === "object") {
    return <span className="text-gray-500 dark:text-gray-400 font-mono">{JSON.stringify(value)}</span>;
  }
  const s = String(value);
  // Truncate long strings in cells; full value visible on hover.
  if (s.length > 80) {
    return <span title={s}>{s.slice(0, 80)}…</span>;
  }
  return s;
}

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">No rows returned.</p>;
  }
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-auto rounded border border-gray-200 dark:border-gray-800 max-h-[500px]">
      <table className="text-xs w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
            {cols.map((c) => (
              <th key={c} className="text-left px-3 py-2 font-semibold text-gray-600 dark:text-gray-400 whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
              {cols.map((c) => (
                <td key={c} className="px-3 py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap max-w-sm">
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
