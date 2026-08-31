// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
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
  id: string | null;
  slug: string | null;
  question: string | null;
  createdAt: string;
  source: string | null;
  /** The dataset's NAME. Everything the client does with it — build a drill
      link, re-run the query — takes a ref, and an id has no business here. */
  dataset: string | null;
  malloyQuery: string | null;
  rowCount: number | null;
  durationMs: number | null;
  authorName: string | null;
  mine?: boolean;
  isFavorited: boolean;
  favoriteCount: number;
};

// Stable identity for a row: the history id, else the share slug, else a
// synthetic key from source+time (deep-linked/just-saved rows have no id yet).
function itemKey(i: HistoryItem): string {
  return i.id ?? i.slug ?? `${i.source}-${i.createdAt}`;
}

// A compact, time-aware stamp for the sidebar. The list is ordered newest-first;
// same-day rows show the TIME so a burst of runs from one session reads in
// chronological order at a glance — showing only the date collapses a whole
// day's runs to an identical string and the list looks unordered. Older rows
// show the date instead.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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

// Full-width dropdown for filtering the sidebar list by Malloy source. Value ""
// means "all sources". Rendered in a portal on document.body so the menu escapes
// the sidebar's overflow-hidden clip.
/** Sources bucketed under the dataset that defines them, datasets in the order
    the API listed them (most-recently-used first) and sources alphabetical
    within each. A source with no dataset — older API responses — collects under
    a blank heading rather than disappearing. */
function groupSourcesByDataset(
  sources: SourceOption[],
): Array<{ key: string; dataset: string; sources: SourceOption[] }> {
  const groups = new Map<string, { key: string; dataset: string; sources: SourceOption[] }>();
  for (const s of sources) {
    const key = s.dataset ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { key, dataset: s.dataset ?? "other", sources: [] };
      groups.set(key, g);
    }
    g.sources.push(s);
  }
  for (const g of groups.values()) g.sources.sort((a, b) => a.source.localeCompare(b.source));
  return [...groups.values()];
}

function SourceFilterPicker({
  value,
  currentDatasetRef,
  sources,
  onChange,
}: {
  value: string;
  /** The dataset the current query belongs to, as an id OR a name — BOTH occur:
      a replayed history item carries the recorded uuid, while a deep link
      carries the readable name (`/ltool?dataset=babynames`). `value` is a bare
      source NAME and names are not unique across datasets — two can each define
      "orders" — so without this the picker cannot tell WHICH "orders" is
      selected: it would mark both and scroll to whichever came first. */
  currentDatasetRef?: string | null;
  sources: SourceOption[];
  onChange: (source: string, option?: SourceOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  /** Is this row the selected one? By dataset too when we know which — matching
      the ref against both the id and the name, since either may reach us. */
  const isSelected = (s: SourceOption) =>
    s.source === value &&
    (!currentDatasetRef || !s.dataset || s.dataset === currentDatasetRef);

  // Open centred on where you already are, not at the top of the list. With one
  // group per dataset the list is long, and landing at the top every time means
  // scrolling to find your own dataset before you can pick a sibling source in
  // it — which is the common move. Scrolls the list box only, never the page.
  useEffect(() => {
    if (!open) return;
    const el = selectedRef.current;
    const box = listRef.current;
    if (!el || !box) return;
    box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2);
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    setOpen(true);
  };

  return (
    <div className="min-w-0">
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center justify-between gap-1 w-full text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-800 bg-transparent hover:border-gray-400 dark:hover:border-gray-600 focus:outline-none"
        title="Filter by source"
      >
        {/* Show the selected source name directly — the `sources` list loads
            async, so a lookup would briefly show the placeholder instead. */}
        <span className={`truncate ${value ? "text-gray-800 dark:text-gray-200 font-semibold" : "text-gray-500 dark:text-gray-400"}`}>
          {value || "Pick a source"}
        </span>
        <span className="text-[9px] text-gray-400 dark:text-gray-600 flex-shrink-0">▾</span>
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            className="fixed z-50 max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1"
            style={{ top: pos.top, left: pos.left, width: Math.max(pos.width, 224) }}
          >
            {/* Grouped by dataset, sources indented beneath it. Flat, the list
                read as arbitrary — it was in API order, which is dataset order,
                but with nothing marking where one dataset ended and the next
                began there was no way to see that. A source name alone also
                isn't unique across datasets. */}
            {groupSourcesByDataset(sources).map((group) => (
              <div key={group.key}>
                <div className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 truncate">
                  {group.dataset}
                </div>
                {group.sources.map((s) => (
                  <button
                    key={`${s.dataset ?? ""}/${s.source}`}
                    ref={isSelected(s) ? selectedRef : undefined}
                    onClick={() => { onChange(s.source, s); setOpen(false); }}
                    className={`block w-full text-left pl-5 pr-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800/60 ${isSelected(s) ? "bg-gray-50 dark:bg-gray-900" : ""}`}
                  >
                    <span className="block font-mono text-[11px] text-gray-800 dark:text-gray-200 truncate">{s.source}</span>
                    {s.description && (
                      <span className="block text-[10px] text-gray-400 dark:text-gray-500 leading-snug line-clamp-2">{s.description}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
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
  if (!item.slug) return null;
  const others = Math.max(0, item.favoriteCount - (item.isFavorited ? 1 : 0));
  // The unfavorited state was gray-300/gray-700 — near-invisible against the
  // row, so it read as decoration rather than a control you could press. It is
  // now a legible gray that still recedes behind the amber of a real favorite,
  // which is what has to stand out in a scanned list.
  const cls = item.isFavorited
    ? "text-amber-400 hover:text-amber-500"
    : others > 0
      ? "text-blue-400 dark:text-blue-500 hover:text-amber-400"
      : "text-gray-400 dark:text-gray-500 hover:text-amber-400 dark:hover:text-amber-500";
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
      className={`text-[32px] leading-none flex-shrink-0 transition-colors rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 ${cls}`}
      title={title}
    >
      {item.isFavorited || others > 0 ? "★" : "☆"}
      {others > 0 && <span className="text-xs align-top ml-0.5 font-semibold">{others}</span>}
    </button>
  );
}

type AskUsage = { input: number; cacheRead: number; cacheWrite: number; output: number };
type AskCost = {
  model: string;
  effort: string | null;
  steps: number;
  usage: AskUsage;
  costUsd: number | null;
};
/** The menu, from /api/me: the defaults plus what may be chosen. `effort` on a
    model says whether that model takes one at all. */
type AskConfig = {
  model: string;
  effort: string;
  models: Array<{ id: string; effort: boolean }>;
  efforts: string[];
};

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Asks land between a tenth of a cent and a few cents, where dollars are all
    leading zeros — so show cents until a question actually costs a dollar. */
function money(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const cents = usd * 100;
  return cents < 0.1 ? "<0.1¢" : `${cents.toFixed(1)}¢`;
}

/** One line under the Ask box, in a fixed position: always who is answering and
    how hard they're thinking, then either how to submit or what the last
    question cost.

    The model is named up front rather than only after a run, because it decides
    both the quality of the answer and the size of the bill, and one key serves
    everyone on the instance. Cached input is called out separately — it is most
    of an agentic loop's input and bills at about a tenth of the rate, so one
    merged total would read as several times more expensive than it was. */
function AskStatusLine({ cost }: { cost: AskCost | null }) {
  if (!cost) {
    return (
      <p className="text-[10px] text-gray-400 dark:text-gray-600">
        Enter to ask · Shift+Enter for a new line
      </p>
    );
  }
  const { usage, steps, costUsd } = cost;
  const cached = usage.cacheRead > 0 ? ` (${tokens(usage.cacheRead)} cached)` : "";
  const parts = [
    `${steps} turn${steps === 1 ? "" : "s"}`,
    `${tokens(usage.input + usage.cacheRead + usage.cacheWrite)} in${cached}`,
    `${tokens(usage.output)} out`,
  ];
  // An estimate, and labelled as one: the rates are compiled in and the invoice
  // is the invoice. Absent for a model with no price on file — and absent for
  // everyone but an admin, who the server withholds it from entirely, so this
  // is a null check rather than a second permission decision.
  if (costUsd != null) parts.push(`~${money(costUsd)}`);
  return <p className="text-[10px] text-gray-400 dark:text-gray-600">{parts.join(" · ")}</p>;
}

/** Model and effort, chosen per question. The effort control is absent — not
    disabled — for a model that takes none, because the API rejects an effort
    there; offering a dead control would only invite a 400. */
function AskControls({
  config,
  model,
  effort,
  onModel,
  onEffort,
  disabled,
}: {
  config: AskConfig;
  model: string;
  effort: string;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
  disabled: boolean;
}) {
  const cls =
    "text-[10px] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1.5 py-0.5 text-gray-600 dark:text-gray-400 disabled:opacity-50";
  const takesEffort = config.models.find((m) => m.id === model)?.effort ?? false;
  return (
    <div className="flex items-center gap-2">
      <select value={model} onChange={(e) => onModel(e.target.value)} disabled={disabled} className={cls}>
        {config.models.map((m) => (
          <option key={m.id} value={m.id}>{m.id}</option>
        ))}
      </select>
      {takesEffort && (
        <select value={effort} onChange={(e) => onEffort(e.target.value)} disabled={disabled} className={cls}>
          {config.efforts.map((e) => (
            <option key={e} value={e}>{e} effort</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** What you can query, when nothing is chosen yet. The same catalogue the
    source dropdown holds, laid out instead of folded away: a source name on its
    own ("order_items", "goals") rarely says what is in it, and the model
    already carries a description for most of them. */
function SourcePicker({
  sources,
  onPick,
}: {
  sources: SourceOption[];
  onPick: (s: SourceOption) => void;
}) {
  if (sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-gray-400 dark:text-gray-600">No sources available yet.</p>
      </div>
    );
  }
  return (
    <div className="px-8 py-6 max-w-2xl space-y-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Pick a source</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          What would you like to look at? Or select a query from the sidebar.
        </p>
      </div>
      {groupSourcesByDataset(sources).map((group) => (
        <div key={group.key} className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 dark:text-gray-500">
            {group.dataset}
          </p>
          <div className="space-y-1">
            {group.sources.map((s) => (
              <button
                key={`${s.dataset ?? ""}/${s.source}`}
                onClick={() => onPick(s)}
                className="block w-full text-left px-3 py-2 rounded border border-gray-200 dark:border-gray-800 hover:border-gray-400 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900/50"
              >
                <span className="block font-mono text-xs text-gray-800 dark:text-gray-200">{s.source}</span>
                {s.description && (
                  <span className="block text-[11px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5">
                    {s.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ask: a question in, a run query out. The Malloy the model writes lands in
    the editor and its result in the panel below, exactly as if it had been
    typed and Run — so what comes back is reviewable and editable, not a black
    box. Rendered only where a source is already chosen: the model needs to
    know what it is querying, and picking that is the human's job. */
function AskBox({
  value,
  onChange,
  onSubmit,
  busy,
  disabled,
  error,
  placeholder,
  cost,
  config,
  model,
  effort,
  onModel,
  onEffort,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  placeholder: string;
  cost: AskCost | null;
  config: AskConfig | null;
  model: string;
  effort: string;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      {/* A textarea, not an input: a question worth asking a model is often a
          couple of sentences of context, and a single line hides all but the
          tail of it while you type. Enter still submits (the common case);
          Shift+Enter breaks the line. */}
      <div className="flex items-start gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // `isComposing` guards the IME: confirming a Japanese/Chinese/Korean
            // candidate is also an Enter, and without this it submits whatever
            // half-converted text is in the box — and bills for the answer.
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          }}
          disabled={busy}
          placeholder={placeholder}
          rows={3}
          className="flex-1 min-w-0 text-xs px-2.5 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 placeholder:text-gray-400 dark:placeholder:text-gray-600 disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y leading-relaxed"
        />
        <button
          onClick={onSubmit}
          disabled={busy || disabled || !value.trim()}
          className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-40 hover:opacity-80 flex-shrink-0"
          title={disabled ? "Choose a source first" : "Write and run a query for this question"}
        >
          {busy ? "asking…" : "Ask"}
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {config ? (
          <AskControls
            config={config}
            model={model}
            effort={effort}
            onModel={onModel}
            onEffort={onEffort}
            disabled={busy}
          />
        ) : (
          <span />
        )}
        <AskStatusLine cost={cost} />
      </div>
      {error && (
        <p className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-2.5 py-2 whitespace-pre-wrap">
          {error}
        </p>
      )}
    </div>
  );
}

export function LtoolApp({ initialSlug, initialSource, initialDatasetId }: { initialSlug?: string; initialSource?: string; initialDatasetId?: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  // Open on my favorites; auto-fall back (once) to all favorites, then history.
  const [view, setView] = useState<View>("favorites");
  const [scope, setScope] = useState<Scope>("me");
  const [filter, setFilter] = useState("");
  // Sidebar list filter by Malloy source; "" = all sources. Seeded from the
  // page's ?source= so the list opens focused on the source in context.
  const [sourceFilter, setSourceFilter] = useState(initialSource ?? "");
  const autoFallback = useRef(true);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Ask — off entirely unless the deployment has an Anthropic key (/api/me).
  const [askAvailable, setAskAvailable] = useState(false);
  const [askQuestion, setAskQuestion] = useState("");
  // The dataset behind the source chosen for a from-scratch ask. Carried from
  // the picker's own option rather than looked up by name, because two datasets
  // may each publish an "orders" and the name alone cannot say which.
  const [askDataset, setAskDataset] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // What the last ask cost. Survives the answer landing, so it is still there
  // while you read the result you paid for.
  const [askCost, setAskCost] = useState<AskCost | null>(null);
  const [askConfig, setAskConfig] = useState<AskConfig | null>(null);
  // The choice for the next question. Empty until /api/me reports the defaults,
  // then whatever was last picked — kept across asks, so a session that wants
  // Opus does not have to re-choose it every time.
  const [askModel, setAskModel] = useState("");
  const [askEffort, setAskEffort] = useState("");
  // The schema panel, where Ask is available. Knowing what fields exist is most
  // of knowing what you can ask, so it starts OPEN and the Malloy starts shut —
  // and from then on nothing but a click changes either.
  const [schemaOpen, setSchemaOpen] = useState(true);
  // The Malloy editor and schema panel are collapsed by default and expand
  // together — most users read results; writing Malloy is the advanced path.
  // Whether the Malloy editor is open.
  //
  // Where Ask is available this belongs to the USER and nothing else touches
  // it: opening a query, running one, or asking a question all leave it exactly
  // as they found it. It is also INDEPENDENT of the schema panel there — the
  // fields are a reference you keep open while writing questions, the Malloy is
  // an implementation detail you unfold when you want it, and pairing them
  // forces one of the two into the wrong state.
  //
  // Without Ask the two stay coupled and automatic — the box auto-opens on a
  // scratch query and closes when you pick another — because there the editor
  // IS the interface and there is no question box to work from.
  const [expanded, setExpanded] = useState(false);
  // Which source the schema panel is *browsing*. Defaults to the loaded query's
  // source but can be changed independently to explore other sources, without
  // retargeting the query.
  const [schemaSource, setSchemaSource] = useState("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showClaudeSetup, setShowClaudeSetup] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  // Click-to-rename a saved (unmodified) query's title, persisted on blur.
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
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

  // Fetch-on-mount/refetch-on-change; loadHistory sets loading/items in its async callback.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => {
      if (d?.instanceName) setInstanceName(d.instanceName);
      if (typeof d?.claudeConnected === "boolean") setClaudeConnected(d.claudeConnected);
      if (d?.askEnabled === true) setAskAvailable(true);
      if (d?.askConfig) {
        setAskConfig(d.askConfig);
        setAskModel(d.askConfig.model);
        setAskEffort(d.askConfig.effort);
      }
      if (d?.user?.isAdmin) setIsAdmin(true);
    }).catch(() => {});
  }, []);

  // Source list for the schema panel's source switcher (name + description).
  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((d: Array<{ dataset: string; sources?: Array<{ source: string; description?: string | null }> }>) => {
        if (!Array.isArray(d)) return;
        // Flattened FROM the grouped catalogue, carrying each source's dataset so
        // the picker can group it back and tell two same-named sources apart —
        // two datasets may each define an "orders".
        const opts: SourceOption[] = [];
        for (const ds of d) {
          for (const s of ds.sources ?? []) {
            if (s.source) opts.push({ source: s.source, description: s.description ?? null, dataset: ds.dataset });
          }
        }
        setSources(opts);
      })
      .catch(() => {});
  }, []);

  // Programmatic expand/collapse. A no-op once Ask is available — see the
  // `expanded` declaration. User-driven toggles call setExpanded directly.
  const autoExpand = useCallback(
    (open: boolean) => { if (!askAvailable) setExpanded(open); },
    [askAvailable],
  );

  const runQuery = useCallback(async (src: string, malloy: string, dataset?: string | null, baseSlug?: string | null, question?: string | null) => {
    if (!src || !malloy.trim()) return;
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // baseSlug lets the server decide author_model (inherit vs 'human').
        body: JSON.stringify({ source: src, malloy, dataset, baseSlug, question }),
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
    // The opened query drives the tabs, not the default fallback chain.
    autoFallback.current = false;
    let cancelled = false;
    fetch(`/api/ltool/share/${initialSlug}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) { setRunError(body.error ?? "could not load shared query"); return; }
        const favoriteCount: number = body.favoriteCount ?? 0;
        const favoritedByMe: boolean = body.favoritedByMe ?? false;
        const authoredByMe: boolean = body.authoredByMe ?? false;
        const item: HistoryItem = {
          id: null, slug: initialSlug, question: body.question ?? null,
          createdAt: new Date().toISOString(), source: body.source ?? null, dataset: body.dataset ?? null,
          malloyQuery: body.malloy ?? null, rowCount: null, durationMs: null,
          authorName: null, mine: authoredByMe, isFavorited: favoritedByMe, favoriteCount,
        };
        setSelected(item);
        setQuery(body.malloy ?? "");
        setSource(body.source ?? "");
        setSchemaSource(body.source ?? "");
        if (body.source) setSourceFilter(body.source);
        autoExpand(false);
        setEditedTitle(null);
        // Open on a tab+scope that actually contains this query.
        // Favorites > History, Me > All (the query is always in the list shown).
        if (favoriteCount > 0) {
          setView("favorites");
          setScope(favoritedByMe ? "me" : "all");
        } else {
          setView("history");
          setScope(authoredByMe ? "me" : "all");
        }
        if (body.source && body.malloy) runQuery(body.source, body.malloy, body.dataset, initialSlug, body.question ?? null);
      })
      .catch((e) => { if (!cancelled) setRunError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [initialSlug, runQuery, autoExpand]);

  // Open an editable scratch query. Nothing is minted here: it carries
  // `id: null, slug: null`, and /api/run mints the slug when it is actually run
  // — so the editor is writable immediately and the query becomes a real,
  // shareable thing only once it has produced a result. Never auto-runs; a
  // starter is incomplete and a blank one more so.
  const openScratch = useCallback((src: string | null, dsRef: string | null) => {
    autoFallback.current = false;
    const starter = src ? `run: ${src} -> ` : "";
    setSelected({
      id: null, slug: null,
      question: src ? `Explore ${src}` : "New query",
      createdAt: new Date().toISOString(), source: src, dataset: dsRef,
      malloyQuery: starter, rowCount: null, durationMs: null,
      authorName: null, isFavorited: false, favoriteCount: 0,
    });
    setQuery(starter);
    setSource(src ?? "");
    setSchemaSource(src ?? "");
    // Expand to show the schema only when there IS a source to show one for.
    autoExpand(Boolean(src));
    setEditedTitle(null);
    setResult(null);
    setRunError(null);
  }, [autoExpand]);

  // Deep-link to a DATASET and/or a SOURCE (the front page's "Query" chip, the
  // dashboard nav's "Query" item, and the empty-dataset tier of the
  // /datasets/<ref> landing chain).
  //
  // The source is optional. It used to be required, and that left the one case
  // that needs this most at a dead end: arrive on a dataset that has no saved
  // queries yet and the sidebar is empty, nothing is selected, and the editor
  // renders "Select a query from the sidebar" — with no query to select and no
  // way to write one. A dataset whose model declares no sources reaches ltool
  // with no `source` at all, which is precisely a freshly loaded dataset.
  useEffect(() => {
    if (initialSlug || (!initialSource && !initialDatasetId)) return;
    // Intentional one-time init of the editor from the deep-link props on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openScratch(initialSource ?? null, initialDatasetId ?? null);
  }, [initialSlug, initialSource, initialDatasetId, openScratch]);

  function selectItem(item: HistoryItem) {
    setSelected(item);
    setQuery(item.malloyQuery ?? "");
    setSource(item.source ?? "");
    setSchemaSource(item.source ?? "");
    // Navigating to a query narrows the list to its source by default.
    if (item.source) setSourceFilter(item.source);
    autoExpand(false);
    setEditedTitle(null);
    setTitleEditing(false);
    setResult(null);
    setRunError(null);
    // A failed ask belongs to the question that produced it. Carrying its error
    // (or its text) onto a different query reads as a complaint about THIS one.
    setAskError(null);
    setAskQuestion("");
    setAskCost(null);
    mainRef.current?.scrollTo({ top: 0 });
    if (item.malloyQuery && item.source) {
      runQuery(item.source, item.malloyQuery, item.dataset, item.slug, item.question);
    }
  }

  // Persist a renamed title (blur/Enter) for the selected saved query, without
  // re-running. Optimistic: updates the header + the sidebar row immediately.
  async function commitTitle() {
    setTitleEditing(false);
    const t = titleDraft.trim();
    const slug = selected?.slug;
    const prev = selected?.question ?? "";
    if (!slug || !canRename || !t || t === prev) return;
    setSelected((s) => (s ? { ...s, question: t } : s));
    setItems((items) => items.map((i) => (i.slug === slug ? { ...i, question: t } : i)));
    try {
      const res = await fetch("/api/saved-queries/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, title: t }),
      });
      if (!res.ok) throw new Error("rename rejected");
    } catch {
      // revert the optimistic rename
      setSelected((s) => (s ? { ...s, question: prev } : s));
      setItems((items) => items.map((i) => (i.slug === slug ? { ...i, question: prev } : i)));
    }
  }

  // Toggle MY star only. Rows linger in place after unfavoriting (a misclick
  // is fixed by clicking again); the list re-filters on the next refresh.
  const toggleFavorite = useCallback(async (e: React.MouseEvent, item: HistoryItem) => {
    e.stopPropagation();
    if (!item.slug) return;
    const nextFav = !item.isFavorited;
    const apply = (fav: boolean, count: number) =>
      setItems((prev) => prev.map((i) => i.slug === item.slug ? { ...i, isFavorited: fav, favoriteCount: count } : i));

    // Optimistic update
    apply(nextFav, Math.max(0, item.favoriteCount + (nextFav ? 1 : -1)));

    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: item.slug }),
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

  // Client-side filters over the loaded list: source dropdown, then free text.
  const q = filter.trim().toLowerCase();
  const visibleItems = items.filter((i) => {
    if (sourceFilter && i.source !== sourceFilter) return false;
    if (!q) return true;
    return (
      (i.question ?? "").toLowerCase().includes(q) ||
      (i.source ?? "").toLowerCase().includes(q) ||
      (i.authorName ?? "").toLowerCase().includes(q)
    );
  });

  // The loaded query has been edited away from what its slug points at.
  // The source the schema panel describes: whatever is in view, whether that is
  // a selected query's source or the one picked on the ask screen.
  const schemaFor = schemaSource || source || sourceFilter || null;
  // Where Ask is available the panel is its own thing, shown whenever it is
  // open and has something to describe. Elsewhere it still rides `expanded`.
  const schemaVisible = askAvailable ? schemaOpen && !!schemaFor : expanded;
  const isModified = !!selected && query.trim() !== (selected.malloyQuery ?? "").trim();
  const modifiedDefaultTitle = `(Modified) ${selected?.question ?? ""}`;
  // You can rename a saved query's title only if it's yours — or you're an admin.
  const canRename = !!selected?.slug && (isAdmin || !!selected?.mine);
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

  // Ask the model for a query and show what it ran. The server does both — see
  // src/app/api/ask/route.ts: it runs what the model wrote so the run is
  // recorded as model-authored, which the client is in no position to assert.
  //
  // A failed ask still fills the editor when the response carried Malloy: a
  // query that compiled but wouldn't run is far more useful in front of the
  // user than an error alone.
  async function handleAsk(askSource: string, dataset: string | null) {
    const q = askQuestion.trim();
    if (!q || !askSource || asking) return;
    setAsking(true);
    setAskError(null);
    setAskCost(null);
    setRunError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: askSource,
          question: q,
          dataset,
          // Only a refinement when the editor is actually showing this source's
          // query; otherwise it's a fresh question and stale Malloy would only
          // mislead.
          currentMalloy: selected && askSource === source ? query : null,
          model: askModel || undefined,
          effort: askEffort || undefined,
        }),
      });
      const json = await res.json();
      // Whether or not it worked — a failed ask still spent tokens.
      if (json.usage) {
        setAskCost({
          model: json.model,
          effort: json.effort ?? null,
          steps: json.steps ?? 0,
          usage: json.usage,
          costUsd: json.costUsd ?? null,
        });
      }
      const malloy = typeof json.malloy === "string" && json.malloy.trim() ? json.malloy : null;
      const item: HistoryItem = {
        id: null,
        slug: json.slug ?? null,
        // The model's synopsis of the query it settled on, when it gave one —
        // it names what the query answers, which is what this row is for. The
        // typed question is the fallback.
        question: typeof json.question === "string" && json.question.trim() ? json.question : q,
        createdAt: new Date().toISOString(),
        source: askSource,
        dataset,
        malloyQuery: malloy,
        rowCount: json.rowCount ?? null,
        durationMs: json.durationMs ?? null,
        authorName: null,
        mine: true,
        isFavorited: false,
        favoriteCount: 0,
      };

      // Whatever came back, if there is a query, open the panel on it — the
      // editor is the whole point, and on the 'compiled but would not run'
      // failure the query is the only thing that explains the error. Without
      // this the panel would still be showing the previous selection, or
      // nothing at all when the ask started from the empty state.
      if (malloy) {
        setQuery(malloy);
        setSource(askSource);
        setSchemaSource(askSource);
        setEditedTitle(null);
        setSelected(item);
      }

      if (!res.ok) { setAskError(json.error ?? "ask failed"); return; }

      setResult(json);
      setAskQuestion("");
      // Same move as Run & save: surface the new row at the top of History (mine).
      // Only on success — a run that failed minted no slug and is not a row
      // anyone can come back to.
      autoFallback.current = false;
      setItems((prev) => [item, ...prev]);
      setView("history");
      setScope("me");
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  // Run the current editor contents. If the query was edited, persist it as a
  // new history entry (fresh slug) under the edited title; otherwise just run.
  async function handleRun() {
    if (!source || !query.trim()) return;
    if (!isModified) { runQuery(source, query, selected?.dataset, selected?.slug, selected?.question); return; }
    const title = (editedTitle ?? modifiedDefaultTitle).trim() || query.trim().slice(0, 80);
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, malloy: query, save: true, title, dataset: selected?.dataset, baseSlug: selected?.slug ?? null }),
      });
      const json = await res.json();
      if (!res.ok) { setRunError(json.error ?? "query failed"); return; }
      setResult(json);
      const newItem: HistoryItem = {
        id: null,
        slug: json.slug ?? null,
        question: title,
        createdAt: new Date().toISOString(),
        source,
        dataset: selected?.dataset ?? null,
        malloyQuery: query,
        rowCount: json.rowCount ?? null,
        durationMs: json.durationMs ?? null,
        authorName: null,
        mine: true,
        isFavorited: false,
        favoriteCount: 0,
      };
      setSelected(newItem);
      setEditedTitle(null);
      // Flip to History (mine) so the query just saved is at the top. Optimistic
      // prepend covers the case where we're already on that tab (no refetch);
      // otherwise changing view/scope triggers loadHistory via its effect.
      autoFallback.current = false;
      setItems((prev) => [newItem, ...prev]);
      setView("history");
      setScope("me");
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
          {/* Source filter — narrows the list to one Malloy source */}
          <SourceFilterPicker
            value={sourceFilter}
            currentDatasetRef={selected?.dataset ?? null}
            sources={sources}
            onChange={(src, opt) => {
              setSourceFilter(src);
              // Switching to a source opens a fresh query against it — always,
              // not just when it has no history. Picking a source is stating
              // what you want to ask about, and leaving the previous source's
              // query sitting in the editor answers a different question than
              // the sidebar is now showing. The filtered history is still right
              // there to click if the answer already exists.
              //
              // "All sources" (empty) is the exception: that clears the filter
              // rather than choosing a subject, so it leaves the editor alone.
              if (src) openScratch(src, opt?.dataset ?? null);
            }}
          />
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
                <li key={itemKey(item)}>
                  <div className={`flex items-start hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors ${
                    selected && itemKey(selected) === itemKey(item)
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
                        <span title={new Date(item.createdAt).toLocaleString()}>{formatWhen(item.createdAt)}</span>
                      </div>
                    </button>
                    <div className="pr-2 pt-2 flex-shrink-0">
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
          // No source yet: there is nothing to ask ABOUT, so offer the choice
          // itself rather than a question box that cannot be used. The list is
          // the same catalogue the picker holds, opened out — a name alone
          // rarely says what a source is for, and the descriptions are already
          // there in the model.
          //
          // Gated on Ask being available, because picking a source has to LEAD
          // somewhere. Without Ask the next screen is "select a query from the
          // sidebar", so the picker would be an invitation followed by a
          // refusal — worse than saying so up front.
          askAvailable && !sourceFilter ? (
            <SourcePicker
              sources={sources}
              onPick={(s) => {
                setSourceFilter(s.source);
                setAskDataset(s.dataset ?? null);
                setSchemaSource(s.source);
              }}
            />
          ) : askAvailable ? (
            <div className="px-8 py-6 max-w-2xl space-y-4">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">Ask a question</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Describe what you want to know about{" "}
                  <span className="font-mono text-gray-700 dark:text-gray-300">{sourceFilter}</span>
                  {" "}— or select a query from the sidebar.
                </p>
              </div>
              <AskBox
                value={askQuestion}
                onChange={setAskQuestion}
                onSubmit={() => handleAsk(sourceFilter, askDataset)}
                busy={asking}
                disabled={false}
                error={askError}
                cost={askCost}
                config={askConfig}
                model={askModel}
                effort={askEffort}
                onModel={setAskModel}
                onEffort={setAskEffort}
                placeholder={`Ask about ${sourceFilter}…`}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-gray-400 dark:text-gray-600">Select a query from the sidebar</p>
            </div>
          )
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
                ) : titleEditing && canRename ? (
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                      else if (e.key === "Escape") { setTitleDraft(selected.question ?? ""); setTitleEditing(false); }
                    }}
                    className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                ) : (
                  <p
                    onClick={() => { if (canRename) { setTitleDraft(selected.question ?? ""); setTitleEditing(true); } }}
                    title={canRename ? "Click to rename" : undefined}
                    className={`text-base font-semibold text-gray-900 dark:text-gray-100 flex-1 ${canRename ? "cursor-text rounded px-1 -mx-1 hover:bg-gray-50 dark:hover:bg-gray-900/50" : ""}`}
                  >
                    {selected.question}
                  </p>
                )}
                <button
                  // The chip is named after the SOURCE, so where the two are
                  // separable it toggles that source's fields, not the editor.
                  onClick={() =>
                    askAvailable ? setSchemaOpen((o) => !o) : setExpanded((o) => !o)
                  }
                  className="flex-shrink-0 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60"
                  title={
                    askAvailable
                      ? schemaOpen ? "Hide fields" : "Show fields"
                      : expanded ? "Hide Malloy & schema" : "Show Malloy & schema"
                  }
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

            {/* Ask — a follow-up question about the source already in view.
                Above the Malloy so the flow reads question → query → result. */}
            {askAvailable && source && (
              <AskBox
                value={askQuestion}
                onChange={setAskQuestion}
                onSubmit={() => handleAsk(source, selected.dataset ?? null)}
                busy={asking}
                disabled={false}
                error={askError}
                cost={askCost}
                config={askConfig}
                model={askModel}
                effort={askEffort}
                onModel={setAskModel}
                onEffort={setAskEffort}
                placeholder={`Ask about ${source}…`}
              />
            )}

            {/* Malloy — a one-line preview until unfolded. Where Ask is
                available this is the editor alone; the fields have their own
                control (the source chip above). */}
            <div className="space-y-2">
              {expanded ? (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Malloy</p>
                    <button
                      onClick={() => setExpanded(false)}
                      className="text-[11px] text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300"
                      title={askAvailable ? "Collapse Malloy" : "Collapse Malloy & schema"}
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
                  title={askAvailable ? "Show Malloy" : "Show Malloy & schema"}
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

            {/* An ask that returns nothing looks like a success and reads like a
                failure. The overwhelmingly common cause is a filter written
                against a guessed representation of a value — the model is told
                the column exists and its type, never what is in it — so name
                that rather than leave an empty table to be puzzled over. */}
            {askCost && result && result.rowCount === 0 && !runError && (
              <p className="text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-2">
                The query ran and matched nothing. Usually that means a filter
                doesn&apos;t match how the values are actually stored — asking for{" "}
                <code>&apos;NY&apos;</code> when the column holds{" "}
                <code>&apos;New York&apos;</code>, say. Check the filter in the Malloy above.
              </p>
            )}

            {runError && (
              <pre className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 whitespace-pre-wrap">
                {runError}
              </pre>
            )}

            {/* Malloy renderer */}
            {result?.stableResult && (
              <div className="space-y-2">
                <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide font-semibold">Results</p>
                <MalloyResultView stableResult={result.stableResult} datasetRef={selected.dataset} />
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

      {schemaVisible && (
        <SchemaPanel
          source={schemaFor}
          sources={sources}
          onSourceChange={setSchemaSource}
          // Closing the fields closes the fields. It only touches the Malloy
          // editor where the two are still coupled (no Ask).
          onClose={() => { setSchemaOpen(false); if (!askAvailable) setExpanded(false); }}
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
