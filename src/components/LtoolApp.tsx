// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { SchemaPanel, type SourceOption } from "@/components/SchemaPanel";

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
  favoriteCount: number;
};

type RunResult = {
  rows: Record<string, unknown>[];
  sql: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  stableResult: Record<string, unknown>;
};

// First meaningful line of a Malloy query, whitespace-collapsed, for the
// collapsed preview bar.
function malloyPreview(query: string): string {
  const line = query
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "(empty)";
  return line.replace(/\s+/g, " ").slice(0, 120);
}

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

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex-shrink-0"
      title="Copy"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

// Star states: amber ★ = my favorite; blue ★ (+count) = favorited only by
// others — clicking adopts it as mine; hollow ☆ = nobody's yet.
function StarButton({
  item,
  onToggle,
}: {
  item: HistoryItem;
  onToggle: (e: React.MouseEvent, item: HistoryItem) => void;
}) {
  if (!item.inquiryId) return null;
  const others = Math.max(0, item.favoriteCount - (item.isFavorited ? 1 : 0));
  const cls = item.isFavorited
    ? "text-amber-400 hover:text-amber-500"
    : others > 0
      ? "text-blue-400 dark:text-blue-500 hover:text-amber-400"
      : "text-gray-300 dark:text-gray-700 hover:text-amber-400 dark:hover:text-amber-500";
  const title = item.isFavorited
    ? others > 0
      ? `Your favorite (+${others} other${others > 1 ? "s" : ""}) — click to remove yours`
      : "Unfavorite"
    : others > 0
      ? `Favorited by ${others} other${others > 1 ? "s" : ""} — click to add yours`
      : "Favorite";
  return (
    <button
      onClick={(e) => onToggle(e, item)}
      className={`text-sm leading-none flex-shrink-0 transition-colors ${cls}`}
      title={title}
    >
      {item.isFavorited || others > 0 ? "★" : "☆"}
      {others > 0 && <span className="text-[9px] align-top ml-0.5">{others}</span>}
    </button>
  );
}

export function LtoolApp({ initialSlug }: { initialSlug?: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  // Open on my favorites; auto-fall back (once) to all favorites, then history.
  const [view, setView] = useState<View>("favorites");
  const [scope, setScope] = useState<Scope>("me");
  const [filter, setFilter] = useState("");
  const autoFallback = useRef(true);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // The Malloy editor and schema panel are collapsed by default and expand
  // together — most users read results; writing Malloy is the advanced path.
  const [expanded, setExpanded] = useState(false);
  // Which source the schema panel is *browsing*. Defaults to the loaded query's
  // source but can be changed independently to explore other sources, without
  // retargeting the query.
  const [schemaSource, setSchemaSource] = useState("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [showClaudeSetup, setShowClaudeSetup] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(() => {
    setLoading(true);
    fetch(`/api/history?scope=${scope}&view=${view}`)
      .then((r) => r.json())
      .then((data) => {
        const arr: HistoryItem[] = Array.isArray(data) ? data : [];
        // Initial-load fallback chain: my favorites → all favorites → my history.
        // Cancelled the moment the user clicks a tab or anything loads.
        if (autoFallback.current && arr.length === 0 && view === "favorites") {
          if (scope === "me") { setScope("all"); return; }
          autoFallback.current = false;
          setView("history");
          setScope("me");
          return;
        }
        autoFallback.current = false;
        setItems(arr);
      })
      .finally(() => setLoading(false));
  }, [scope, view]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => {
      if (d?.instanceName) setInstanceName(d.instanceName);
      if (typeof d?.claudeConnected === "boolean") setClaudeConnected(d.claudeConnected);
    }).catch(() => {});
  }, []);

  // Source list for the schema panel's source switcher (name + description).
  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((d: Array<{ source: string; description?: string | null }>) => {
        if (!Array.isArray(d)) return;
        const seen = new Set<string>();
        const opts: SourceOption[] = [];
        for (const s of d) {
          if (s.source && !seen.has(s.source)) {
            seen.add(s.source);
            opts.push({ source: s.source, description: s.description ?? null });
          }
        }
        setSources(opts);
      })
      .catch(() => {});
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
          authorName: null, isFavorited: false, favoriteCount: 0,
        };
        setSelected(item);
        setQuery(body.malloy ?? "");
        setSource(body.source ?? "");
        setSchemaSource(body.source ?? "");
        setExpanded(false);
        setEditedTitle(null);
        if (body.source && body.malloy) runQuery(body.source, body.malloy);
      })
      .catch((e) => { if (!cancelled) setRunError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [initialSlug, runQuery]);

  function selectItem(item: HistoryItem) {
    setSelected(item);
    setQuery(item.malloyQuery ?? "");
    setSource(item.source ?? "");
    setSchemaSource(item.source ?? "");
    setExpanded(false);
    setEditedTitle(null);
    setResult(null);
    setRunError(null);
    mainRef.current?.scrollTo({ top: 0 });
    if (item.malloyQuery && item.source) {
      runQuery(item.source, item.malloyQuery);
    }
  }

  // Toggle MY star only. Rows linger in place after unfavoriting (a misclick
  // is fixed by clicking again); the list re-filters on the next refresh.
  const toggleFavorite = useCallback(async (e: React.MouseEvent, item: HistoryItem) => {
    e.stopPropagation();
    if (!item.inquiryId) return;
    const nextFav = !item.isFavorited;
    const apply = (fav: boolean, count: number) =>
      setItems((prev) => prev.map((i) => i.inquiryId === item.inquiryId ? { ...i, isFavorited: fav, favoriteCount: count } : i));

    // Optimistic update
    apply(nextFav, Math.max(0, item.favoriteCount + (nextFav ? 1 : -1)));

    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inquiryId: item.inquiryId }),
      });
      const json = await res.json() as { isFavorited: boolean };
      if (json.isFavorited !== nextFav) {
        // Server disagreed (e.g. double-click race) — trust it.
        apply(json.isFavorited, Math.max(0, item.favoriteCount + (json.isFavorited ? 1 : -1)));
      }
    } catch {
      // Revert on error
      apply(item.isFavorited, item.favoriteCount);
    }
  }, []);

  // Client-side text filter over the loaded list.
  const visibleItems = filter.trim()
    ? items.filter((i) => {
        const q = filter.trim().toLowerCase();
        return (
          (i.question ?? "").toLowerCase().includes(q) ||
          (i.source ?? "").toLowerCase().includes(q) ||
          (i.authorName ?? "").toLowerCase().includes(q)
        );
      })
    : items;

  // The loaded query has been edited away from what its slug points at.
  const isModified = !!selected && query.trim() !== (selected.malloyQuery ?? "").trim();
  const modifiedDefaultTitle = `(Modified) ${selected?.question ?? ""}`;
  // Clear the slug while modified — it no longer matches the editor contents.
  const activeSlug = isModified ? null : selected?.slug ?? null;

  const shareUrl = activeSlug ? `${typeof window !== "undefined" ? window.location.origin : ""}/ltool/${activeSlug}` : null;

  // The tool name is namespaced (${instanceName}:open_share_link) so Claude calls
  // the exact connector+tool instead of discovering it — important because
  // Claude only surfaces a handful of a connector's tools up front.
  const claudeUrl = activeSlug
    ? `https://claude.ai/new?q=${encodeURIComponent(
        `Using the ${instanceName} Malloy tools, Call ${instanceName}:open_share_link with slug "${activeSlug}", then ask me what I'd like to know.`
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
        favoriteCount: 0,
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
            <TabButton active={view === "history"} onClick={() => { autoFallback.current = false; setView("history"); }}>History</TabButton>
            <TabButton active={view === "favorites"} onClick={() => { autoFallback.current = false; setView("favorites"); }}>Favorites</TabButton>
            <div className="flex-1" />
            <TabButton active={scope === "me"} onClick={() => { autoFallback.current = false; setScope("me"); }}>Me</TabButton>
            <TabButton active={scope === "all"} onClick={() => { autoFallback.current = false; setScope("all"); }}>All</TabButton>
          </div>
          {/* Filter — searches question, source, and author */}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="w-full text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-800 bg-transparent placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-gray-400 dark:focus:border-gray-600"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">loading…</p>
          ) : visibleItems.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3">
              {filter.trim()
                ? "No matches."
                : view === "favorites" ? "No favorites yet." : "No queries yet."}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {visibleItems.map((item) => (
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
                      <p
                        className="text-xs font-medium text-gray-800 dark:text-gray-200 line-clamp-2 leading-snug"
                        title={item.question ?? ""}
                      >
                        {item.question}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {item.source && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                            {item.source}
                          </span>
                        )}
                        {item.authorName && (scope === "all" || view === "favorites") && (
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
                  onClick={() => setExpanded((o) => !o)}
                  className="flex-shrink-0 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60"
                  title={expanded ? "Hide Malloy & schema" : "Show Malloy & schema"}
                >
                  {source || "schema"}
                </button>
              </div>
              {isModified && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">Edited — running will save this as a new query.</p>
              )}
              {!isModified && selected.authorName && (scope === "all" || view === "favorites") && (
                <p className="text-xs text-gray-400 dark:text-gray-600">by {selected.authorName}</p>
              )}
            </div>

            {/* Malloy — collapsed to a one-line preview by default; expanding
                also opens the schema panel (they travel together). */}
            <div className="space-y-2">
              {expanded ? (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Malloy</p>
                    <button
                      onClick={() => setExpanded(false)}
                      className="text-[11px] text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300"
                      title="Collapse Malloy & schema"
                    >
                      ▾ collapse
                    </button>
                  </div>
                  <MalloyCodeEditor value={query} onChange={setQuery} minHeight="120px" />
                </>
              ) : (
                <button
                  onClick={() => setExpanded(true)}
                  className="w-full flex items-baseline gap-2 text-left px-2.5 py-2 rounded border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900/50 group"
                  title="Show Malloy & schema"
                >
                  <span className="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0">▸</span>
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 dark:text-gray-600 flex-shrink-0">Malloy</span>
                  <span className="text-[11px] font-mono text-gray-600 dark:text-gray-400 truncate flex-1">
                    {malloyPreview(query)}
                  </span>
                  <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0 group-hover:underline">
                    expand ▾
                  </span>
                </button>
              )}
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
                <button
                  onClick={() => {
                    if (claudeConnected) window.open(claudeUrl, "_blank", "noopener,noreferrer");
                    else setShowClaudeSetup(true);
                  }}
                  className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
                  title={`Open a new Claude chat seeded with this query on ${instanceName}`}
                >
                  Explore further with Claude →
                </button>
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

      {expanded && (
        <SchemaPanel
          source={schemaSource || source || null}
          sources={sources}
          onSourceChange={setSchemaSource}
          onClose={() => setExpanded(false)}
        />
      )}

      {/* One-time claude.ai connection instructions, shown before following the
          Explore link when this user has never completed the MCP OAuth flow. */}
      {showClaudeSetup && claudeUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setShowClaudeSetup(false)}
        >
          <div
            className="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold">Connect {instanceName} to Claude first</h2>
              <button
                onClick={() => setShowClaudeSetup(false)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 leading-none"
                title="Close"
              >
                ×
              </button>
            </div>

            <p className="text-xs text-gray-600 dark:text-gray-400">
              It looks like you haven&apos;t connected {instanceName} to claude.ai yet.
              Without the connection, Claude can&apos;t load this query. One-time setup:
            </p>

            <ol className="list-decimal list-inside text-xs text-gray-700 dark:text-gray-300 space-y-2">
              <li>
                Open{" "}
                <a
                  href="https://claude.ai/customize/connectors"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-900 dark:hover:text-gray-100"
                >
                  claude.ai → Settings → Connectors
                </a>
              </li>
              <li>Click <strong>Add custom connector</strong> and enter:</li>
            </ol>

            <div className="space-y-1.5 pl-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-12 flex-shrink-0">Name</span>
                <code className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-0.5 flex-1 truncate">{instanceName}</code>
                <CopyChip value={instanceName} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-12 flex-shrink-0">URL</span>
                <code className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-0.5 flex-1 truncate">
                  {typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp"}
                </code>
                <CopyChip value={typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp"} />
              </div>
            </div>

            <ol className="list-decimal list-inside text-xs text-gray-700 dark:text-gray-300 space-y-2" start={3}>
              <li>Finish the Google sign-in when claude.ai prompts you</li>
            </ol>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => {
                  window.open(claudeUrl, "_blank", "noopener,noreferrer");
                  setShowClaudeSetup(false);
                }}
                className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black hover:opacity-80"
              >
                Continue on to Claude.ai →
              </button>
              <button
                onClick={() => setShowClaudeSetup(false)}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
