"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { SchemaPanel } from "@/components/SchemaPanel";

const MalloyCodeEditor = dynamic(
  () => import("@/components/MalloyCodeEditor").then((m) => m.MalloyCodeEditor),
  { ssr: false, loading: () => <div className="h-32 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900" /> },
);

const MalloyResultView = dynamic(
  () => import("@/components/MalloyResultView").then((m) => m.MalloyResultView),
  { ssr: false, loading: () => <div className="h-40 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 animate-pulse" /> },
);

type View = "history" | "favorites";
type Scope = "me" | "all";

type HistoryItem = {
  inquiryId: string | null;
  slug: string | null;
  question: string | null;
  createdAt: string;
  source: string | null;
  datasetId: string | null;
  malloyQuery: string | null;
  rowCount: number | null;
  durationMs: number | null;
  authorName: string | null;
  isFavorited: boolean;
};

type RunResult = {
  rows: Record<string, unknown>[];
  sql: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  stableResult: Record<string, unknown>;
};

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded transition-colors ${
        active
          ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
          : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

function StarButton({
  item,
  onToggle,
}: {
  item: HistoryItem;
  onToggle: (e: React.MouseEvent, item: HistoryItem) => void;
}) {
  if (!item.inquiryId) return null;
  return (
    <button
      onClick={(e) => onToggle(e, item)}
      className={`text-sm leading-none flex-shrink-0 transition-colors ${
        item.isFavorited
          ? "text-amber-400 hover:text-amber-500"
          : "text-gray-300 dark:text-gray-700 hover:text-amber-400 dark:hover:text-amber-500"
      }`}
      title={item.isFavorited ? "Unfavorite" : "Favorite"}
    >
      {item.isFavorited ? "★" : "☆"}
    </button>
  );
}

export function LtoolApp({ initialSlug }: { initialSlug?: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [view, setView] = useState<View>("history");
  const [scope, setScope] = useState<Scope>("me");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [shareCopied, setShareCopied] = useState(false);
  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(() => {
    setLoading(true);
    fetch(`/api/history?scope=${scope}&view=${view}`)
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, [scope, view]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => { if (d?.instanceName) setInstanceName(d.instanceName); }).catch(() => {});
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

  // Deep-link: hydrate from a shared slug and auto-run.
  useEffect(() => {
    if (!initialSlug) return;
    let cancelled = false;
    fetch(`/api/ltool/share/${initialSlug}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) { setRunError(body.error ?? "could not load shared query"); return; }
        const item: HistoryItem = {
          inquiryId: null, slug: initialSlug, question: body.question ?? null,
          createdAt: new Date().toISOString(), source: body.source ?? null, datasetId: null,
          malloyQuery: body.malloy ?? null, rowCount: null, durationMs: null,
          authorName: null, isFavorited: false,
        };
        setSelected(item);
        setQuery(body.malloy ?? "");
        setSource(body.source ?? "");
        setEditedTitle(null);
        if (body.source) setSchemaOpen(true);
        if (body.source && body.malloy) runQuery(body.source, body.malloy);
      })
      .catch((e) => { if (!cancelled) setRunError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [initialSlug, runQuery]);

  function selectItem(item: HistoryItem) {
    setSelected(item);
    setQuery(item.malloyQuery ?? "");
    setSource(item.source ?? "");
    setEditedTitle(null);
    setResult(null);
    setRunError(null);
    if (item.source) setSchemaOpen(true);
    mainRef.current?.scrollTo({ top: 0 });
    if (item.malloyQuery && item.source) {
      runQuery(item.source, item.malloyQuery);
    }
  }

  const toggleFavorite = useCallback(async (e: React.MouseEvent, item: HistoryItem) => {
    e.stopPropagation();
    if (!item.inquiryId) return;
    const nextFav = !item.isFavorited;

    // Optimistic update
    setItems((prev) =>
      prev.map((i) => i.inquiryId === item.inquiryId ? { ...i, isFavorited: nextFav } : i)
    );

    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inquiryId: item.inquiryId }),
      });
      const json = await res.json() as { isFavorited: boolean };
      if (view === "favorites" && !json.isFavorited) {
        // Remove from list when unfavoriting in favorites view
        setItems((prev) => prev.filter((i) => i.inquiryId !== item.inquiryId));
        if (selected?.inquiryId === item.inquiryId) setSelected(null);
      } else {
        setItems((prev) =>
          prev.map((i) => i.inquiryId === item.inquiryId ? { ...i, isFavorited: json.isFavorited } : i)
        );
      }
    } catch {
      // Revert on error
      setItems((prev) =>
        prev.map((i) => i.inquiryId === item.inquiryId ? { ...i, isFavorited: item.isFavorited } : i)
      );
    }
  }, [view, selected]);

  // The loaded query has been edited away from what its slug points at.
  const isModified = !!selected && query.trim() !== (selected.malloyQuery ?? "").trim();
  const modifiedDefaultTitle = `(Modified) ${selected?.question ?? ""}`;
  // Clear the slug while modified — it no longer matches the editor contents.
  const activeSlug = isModified ? null : selected?.slug ?? null;

  const shareUrl = activeSlug ? `${typeof window !== "undefined" ? window.location.origin : ""}/ltool/${activeSlug}` : null;

  const claudeUrl = activeSlug
    ? `https://claude.ai/new?q=${encodeURIComponent(
        `Using the ${instanceName} Malloy tools, continue exploring${source ? ` the "${source}" source` : ""}.` +
        (selected?.question ? ` I was looking at: "${selected.question}".` : "") +
        ` Call describe_query with slug "${activeSlug}" to load the exact query, then go deeper.`
      )}`
    : null;

  // Run the current editor contents. If the query was edited, persist it as a
  // new history entry (fresh slug) under the edited title; otherwise just run.
  async function handleRun() {
    if (!source || !query.trim()) return;
    if (!isModified) { runQuery(source, query); return; }
    const title = (editedTitle ?? modifiedDefaultTitle).trim() || query.trim().slice(0, 80);
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, malloy: query, save: true, title }),
      });
      const json = await res.json();
      if (!res.ok) { setRunError(json.error ?? "query failed"); return; }
      setResult(json);
      const newItem: HistoryItem = {
        inquiryId: json.inquiryId ?? null,
        slug: json.slug ?? null,
        question: title,
        createdAt: new Date().toISOString(),
        source,
        datasetId: selected?.datasetId ?? null,
        malloyQuery: query,
        rowCount: json.rowCount ?? null,
        durationMs: json.durationMs ?? null,
        authorName: null,
        isFavorited: false,
      };
      setSelected(newItem);
      setEditedTitle(null);
      loadHistory();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function copyShare() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1200);
  }

  return (
    <div className="flex h-screen overflow-hidden font-mono text-sm" style={{ minWidth: 0 }}>
      {/* Sidebar */}
      <aside className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 space-y-2">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← home</Link>
            <button
              onClick={loadHistory}
              disabled={loading}
              className="text-xs text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40"
              title="Refresh"
            >
              ↻
            </button>
          </div>
          {/* Tabs + scope toggle */}
          <div className="flex items-center gap-1">
            <TabButton active={view === "history"} onClick={() => setView("history")}>History</TabButton>
            <TabButton active={view === "favorites"} onClick={() => setView("favorites")}>Favorites</TabButton>
            <div className="flex-1" />
            <TabButton active={scope === "me"} onClick={() => setScope("me")}>Me</TabButton>
            <TabButton active={scope === "all"} onClick={() => setScope("all")}>All</TabButton>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">loading…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">
              {view === "favorites" ? "No favorites yet." : "No queries yet."}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {items.map((item) => (
                <li key={item.inquiryId ?? `${item.source}-${item.createdAt}`}>
                  <div className={`flex items-start hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors ${
                    selected?.inquiryId === item.inquiryId && selected?.createdAt === item.createdAt
                      ? "bg-blue-50 dark:bg-blue-950/30 border-l-2 border-blue-500"
                      : ""
                  }`}>
                    <button
                      onClick={() => selectItem(item)}
                      className="flex-1 text-left px-4 py-3 min-w-0"
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
                        {item.authorName && scope === "all" && (
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
                    <div className="pr-3 pt-3 flex-shrink-0">
                      <StarButton item={item} onToggle={toggleFavorite} />
                    </div>
                  </div>
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
                {isModified ? (
                  <input
                    value={editedTitle ?? modifiedDefaultTitle}
                    onChange={(e) => setEditedTitle(e.target.value)}
                    placeholder="Title for this query"
                    className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
                  />
                ) : (
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100 flex-1">{selected.question}</p>
                )}
                <button
                  onClick={() => setSchemaOpen((o) => !o)}
                  className="flex-shrink-0 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60"
                  title={schemaOpen ? "Hide schema" : "Show schema"}
                >
                  {source || "schema"}
                </button>
              </div>
              {isModified && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">Edited — running will save this as a new query.</p>
              )}
              {!isModified && selected.authorName && scope === "all" && (
                <p className="text-xs text-gray-400 dark:text-gray-600">by {selected.authorName}</p>
              )}
            </div>

            {/* Malloy editor */}
            <div className="space-y-2">
              <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Malloy</p>
              <MalloyCodeEditor value={query} onChange={setQuery} minHeight="120px" />
            </div>

            {/* Run + share buttons */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleRun}
                disabled={running || !source || !query.trim()}
                className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-40 hover:opacity-80"
              >
                {running ? "running…" : isModified ? "Run & save" : "Run"}
              </button>
              {shareUrl && (
                <button
                  onClick={copyShare}
                  className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
                  title="Copy a shareable link to this query"
                >
                  {shareCopied ? "copied link" : "Share"}
                </button>
              )}
              {claudeUrl && (
                <a
                  href={claudeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
                  title={`Open a new Claude chat seeded with this query on ${instanceName}`}
                >
                  Explore further with Claude →
                </a>
              )}
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

      {schemaOpen && (
        <SchemaPanel source={source || null} onClose={() => setSchemaOpen(false)} />
      )}
    </div>
  );
}
