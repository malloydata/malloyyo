"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const MalloyCodeEditor = dynamic(
  () => import("@/components/MalloyCodeEditor").then((m) => m.MalloyCodeEditor),
  { ssr: false, loading: () => <div className="h-32 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900" /> },
);

const MalloyResultView = dynamic(
  () => import("@/components/MalloyResultView").then((m) => m.MalloyResultView),
  { ssr: false, loading: () => <div className="h-40 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 animate-pulse" /> },
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
  authorName: string | null;
};

type RunResult = {
  rows: Record<string, unknown>[];
  sql: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  stableResult: Record<string, unknown>;
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
  const mainRef = useRef<HTMLDivElement>(null);

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
    mainRef.current?.scrollTo({ top: 0 });
    if (item.malloyQuery && item.source) {
      runQuery(item.source, item.malloyQuery);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden font-mono text-sm">
      {/* Sidebar */}
      <aside className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← home</Link>
          <h1 className="text-sm font-bold mt-1">Query history</h1>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">loading…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">No queries yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {items.map((item) => (
                <li key={item.inquiryId}>
                  <button
                    onClick={() => selectItem(item)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors ${
                      selected?.inquiryId === item.inquiryId
                        ? "bg-blue-50 dark:bg-blue-950/30 border-l-2 border-blue-500"
                        : ""
                    }`}
                  >
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200 line-clamp-2 leading-snug">
                      {item.question}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {item.source && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                          {item.source}
                        </span>
                      )}
                      {item.authorName && (
                        <span className="text-[10px] text-gray-400 dark:text-gray-600 truncate max-w-[100px]">
                          {item.authorName}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-400 dark:text-gray-600">
                      {item.rowCount != null && <span>{item.rowCount.toLocaleString()} rows</span>}
                      {item.durationMs != null && <span>{(item.durationMs / 1000).toFixed(1)}s</span>}
                      <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main ref={mainRef} className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-gray-400 dark:text-gray-600">Select a query from the sidebar</p>
          </div>
        ) : (
          <div className="px-8 py-6 space-y-5 max-w-4xl">
            {/* Question + meta */}
            <div className="space-y-1">
              <div className="flex items-start gap-3">
                <p className="text-base font-semibold text-gray-900 dark:text-gray-100 flex-1">{selected.question}</p>
                {source && (
                  <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                    {source}
                  </span>
                )}
              </div>
              {selected.authorName && (
                <p className="text-xs text-gray-400 dark:text-gray-600">by {selected.authorName}</p>
              )}
            </div>

            {/* Malloy editor */}
            <div className="space-y-2">
              <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Malloy</p>
              <MalloyCodeEditor value={query} onChange={setQuery} minHeight="120px" />
            </div>

            {/* Run button */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => runQuery(source, query)}
                disabled={running || !source || !query.trim()}
                className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-40 hover:opacity-80"
              >
                {running ? "running…" : "Run"}
              </button>
              {result && !running && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {result.rowCount.toLocaleString()} rows · {(result.durationMs / 1000).toFixed(2)}s
                  {result.truncated && " · truncated"}
                </span>
              )}
            </div>

            {runError && (
              <pre className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 whitespace-pre-wrap">
                {runError}
              </pre>
            )}

            {/* Malloy renderer */}
            {result?.stableResult && (
              <div className="space-y-2">
                <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Results</p>
                <MalloyResultView stableResult={result.stableResult} />
              </div>
            )}

            {/* SQL details */}
            {result?.sql && (
              <details className="text-xs">
                <summary className="text-gray-400 dark:text-gray-600 cursor-pointer hover:text-gray-600 dark:hover:text-gray-400 select-none">
                  SQL
                </summary>
                <pre className="mt-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded p-3 overflow-auto whitespace-pre text-[11px] text-gray-600 dark:text-gray-400">
                  {result.sql}
                </pre>
              </details>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
