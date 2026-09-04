// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The chat app: a list of conversations on the left, one conversation on the
// right, each scoped to a single dataset:source.
//
// The live turn is held separately from the stored messages. Events arrive as
// SSE and are assembled into a provisional assistant message; when the turn ends
// the whole conversation is refetched, so what you end up looking at is what was
// actually persisted rather than what the client believed it saw.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SchemaPanel, type SourceOption } from "@/components/SchemaPanel";
import { ChatMessages, type StoredMessage, type StoredResult } from "@/components/ChatMessages";

type ChatSummary = {
  id: string;
  dataset: string;
  source: string;
  title: string | null;
  /** Published: readable by anyone signed in to this instance, never writable. */
  isPublic?: boolean;
  updatedAt: string;
};

type AskConfig = {
  model: string;
  effort: string;
  models: Array<{ id: string; effort: boolean }>;
  efforts: string[];
};

type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** What the loop emits, mirrored from src/lib/chat/loop.ts. */
type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      ok: boolean;
      text: string;
      malloy?: string;
      sql?: string;
      rowCount?: number;
      slug?: string | null;
      stableResult?: unknown;
    }
  | { type: "done"; steps: number; usage: Usage; costUsd: number | null; model: string; effort: string | null }
  | { type: "error"; message: string };

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function money(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const cents = usd * 100;
  return cents < 0.1 ? "<0.1¢" : `${cents.toFixed(1)}¢`;
}

/** Seconds since `since`, ticking — a turn runs long enough that a static label
    reads as a hang. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [since]);
  return since == null ? 0 : Math.max(0, (now - since) / 1000);
}

export function ChatApp({
  initialChatId,
  initialDataset,
  initialSource,
}: {
  initialChatId?: string;
  /** `?dataset=&source=` — start a chat on this source and open it. */
  initialDataset?: string;
  initialSource?: string;
}) {
  const router = useRouter();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialChatId ?? null);
  const [chat, setChat] = useState<ChatSummary | null>(null);
  // Whether the OPEN chat is mine. A chat someone published is readable by
  // anyone signed in, and a reader gets no composer and no publish control —
  // asking would append to their transcript, which the server refuses anyway.
  const [mine, setMine] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [results, setResults] = useState<StoredResult[]>([]);

  const [sources, setSources] = useState<SourceOption[]>([]);
  const [config, setConfig] = useState<AskConfig | null>(null);
  const [available, setAvailable] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<{ steps: number; usage: Usage; costUsd: number | null } | null>(null);
  const [showSchema, setShowSchema] = useState(true);

  // The turn in flight, assembled from events.
  const [liveText, setLiveText] = useState("");
  const [liveTools, setLiveTools] = useState<Array<{ id: string; name: string; input: Record<string, unknown>; result?: StoredResult; ok?: boolean }>>([]);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(startedAt);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        if (d?.askEnabled === true) setAvailable(true);
        if (d?.askConfig) {
          setConfig(d.askConfig);
          setModel(d.askConfig.model);
          setEffort(d.askConfig.effort);
        }
      })
      .catch(() => {});
    fetch("/api/sources")
      .then((r) => r.json())
      .then((d: Array<{ dataset: string; sources?: Array<{ source: string; description?: string | null }> }>) => {
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

  const loadChats = useCallback(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setChats(d))
      .catch(() => {});
  }, []);
  useEffect(loadChats, [loadChats]);

  // Purely async: everything it sets happens in a promise callback. Clearing the
  // previous conversation is the SELECTION's job (below), not this one's — a
  // synchronous setState inside the effect below would cascade renders.
  const openChat = useCallback((id: string) => {
    return fetch(`/api/chats/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.chat) {
          setChat(d.chat);
          setMine(d.mine !== false);
          setMessages(d.messages ?? []);
          setResults(d.results ?? []);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeId) void openChat(activeId);
  }, [activeId, openChat]);

  /** Move to another conversation: forget the last one's live state, then let
      the effect above fetch the new one. */
  const selectChat = useCallback(
    (id: string) => {
      setError(null);
      setLastTurn(null);
      setLiveText("");
      setLiveTools([]);
      setChat(null);
      setMessages([]);
      setResults([]);
      setActiveId(id);
      router.replace(`/chat?id=${id}`);
    },
    [router],
  );

  // Follow the conversation as it grows, the way a terminal does.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, liveText, liveTools]);

  const newChat = useCallback(
    async (s: SourceOption) => {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataset: s.dataset, source: s.source }),
      });
      const created = await res.json();
      if (!res.ok) return setError(created.error ?? "could not start a chat");
      loadChats();
      selectChat(created.id);
    },
    [loadChats, selectChat],
  );

  async function togglePublic() {
    if (!chat || !activeId || publishing) return;
    const next = !chat.isPublic;
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`/api/chats/${activeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: next }),
      });
      const body = await res.json();
      if (!res.ok) return setError(body.error ?? "could not change sharing");
      setChat((c) => (c ? { ...c, isPublic: next } : c));
      setChats((list) => list.map((c) => (c.id === activeId ? { ...c, isPublic: next } : c)));
    } finally {
      setPublishing(false);
    }
  }

  // A `?dataset=&source=` deep link: create the chat, once. The ref is what
  // makes it once — this creates a row, and StrictMode runs an effect twice.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || initialChatId || !initialDataset || !initialSource) return;
    seeded.current = true;
    void newChat({ dataset: initialDataset, source: initialSource, description: null });
  }, [initialChatId, initialDataset, initialSource, newChat]);

  async function send() {
    const q = question.trim();
    if (!q || !activeId || busy) return;
    setBusy(true);
    setStartedAt(Date.now());
    setError(null);
    setLastTurn(null);
    setLiveText("");
    setLiveTools([]);
    // Shown immediately: waiting to see your own question echoed is the one
    // thing a chat must never make you do.
    setMessages((prev) => [...prev, { role: "user", content: [{ type: "text", text: q }] }]);
    setQuestion("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/chats/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, model: model || undefined, effort: effort || undefined }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "the chat failed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a partial frame stays in the
        // buffer until the rest of it arrives.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev: ChatEvent;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          applyEvent(ev);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStartedAt(null);
      abortRef.current = null;
      // Refetch so the transcript is the stored one, not the assembled one, then
      // drop the live copy so the two are never shown at once.
      if (activeId) {
        await openChat(activeId);
        setLiveText("");
        setLiveTools([]);
      }
      loadChats();
    }
  }

  function applyEvent(ev: ChatEvent) {
    switch (ev.type) {
      case "text":
        setLiveText((t) => t + ev.text);
        break;
      case "tool_start":
        setLiveTools((ts) => [...ts, { id: ev.id, name: ev.name, input: ev.input }]);
        break;
      case "tool_result":
        setLiveTools((ts) =>
          ts.map((t) =>
            t.id === ev.id
              ? {
                  ...t,
                  ok: ev.ok,
                  result: ev.stableResult
                    ? {
                        toolUseId: ev.id,
                        malloy: ev.malloy ?? null,
                        sql: ev.sql ?? null,
                        rowCount: ev.rowCount ?? null,
                        slug: ev.slug ?? null,
                        stableResult: ev.stableResult,
                      }
                    : undefined,
                }
              : t,
          ),
        );
        break;
      case "done":
        setLastTurn({ steps: ev.steps, usage: ev.usage, costUsd: ev.costUsd });
        break;
      case "error":
        setError(ev.message);
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  if (!available) {
    return (
      <div className="flex h-screen items-center justify-center font-mono text-sm">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Chat is not configured on this instance.
        </p>
      </div>
    );
  }

  // The live turn, shaped like stored messages so one renderer draws both.
  const liveMessages: StoredMessage[] = [];
  if (liveTools.length || liveText) {
    liveMessages.push({
      role: "assistant",
      content: [
        ...liveTools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
        ...(liveText ? [{ type: "text", text: liveText }] : []),
      ],
    });
  }
  const liveResults = liveTools.flatMap((t) => (t.result ? [t.result] : []));

  return (
    <div className="flex h-screen overflow-hidden font-mono text-sm" style={{ minWidth: 0 }}>
      <aside className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 space-y-2">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
              ← home
            </Link>
            <NewChatButton sources={sources} onPick={newChat} />
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {chats.length === 0 ? (
            <p className="px-4 py-6 text-xs text-gray-400 dark:text-gray-600">
              No chats yet. Press + to start one.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => selectChat(c.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/50 ${
                      c.id === activeId ? "bg-blue-50 dark:bg-blue-950/30 border-l-2 border-blue-500" : ""
                    }`}
                  >
                    <p className="text-xs text-gray-800 dark:text-gray-200 line-clamp-2 leading-snug">
                      {c.title ?? "New chat"}
                    </p>
                    <span className="mt-1.5 inline-flex items-center gap-1">
                      <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                        {c.source}
                      </span>
                      {c.isPublic && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          public
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        {!chat ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-400 dark:text-gray-600">
              Pick a chat, or press + to start one.
            </p>
          </div>
        ) : (
          <>
            <header className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{chat.title ?? "New chat"}</p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  {chat.dataset} · {chat.source}
                </p>
              </div>
              <div className="flex-shrink-0 flex items-center gap-2">
                {mine ? (
                  <button
                    onClick={togglePublic}
                    disabled={publishing}
                    title={
                      chat.isPublic
                        ? "Anyone signed in can read this chat. Click to make it private again."
                        : "Let anyone signed in read this chat. They cannot add to it."
                    }
                    className={`text-xs px-2 py-0.5 rounded border disabled:opacity-50 ${
                      chat.isPublic
                        ? "border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50"
                        : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    {chat.isPublic ? "✓ public" : "make public"}
                  </button>
                ) : (
                  <span
                    title="Someone else's chat, shared with you. You can read it; asking would add to their conversation."
                    className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400"
                  >
                    read-only
                  </span>
                )}
                <button
                  onClick={() => setShowSchema((s) => !s)}
                  className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60"
                >
                  {showSchema ? "hide fields" : "fields"}
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="max-w-3xl">
                <ChatMessages
                  messages={[...messages, ...liveMessages]}
                  results={[...results, ...liveResults]}
                  dataset={chat.dataset}
                />
                {error && (
                  <p className="mt-4 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-2.5 py-2">
                    {error}
                  </p>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            {/* No composer on someone else's chat. The server refuses the post
                anyway (the messages route is owner-scoped), but a text box that
                fails on submit is a worse way to learn that than not having
                one. */}
            {!mine ? (
              <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-3">
                <p className="max-w-3xl text-[11px] text-gray-600 dark:text-gray-400">
                  Shared with you to read. To ask your own questions about{" "}
                  <span className="font-medium">{chat.source}</span>,{" "}
                  <Link
                    href={`/chat?dataset=${encodeURIComponent(chat.dataset)}&source=${encodeURIComponent(chat.source)}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    start your own chat
                  </Link>
                  .
                </p>
              </div>
            ) : (
            <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-3 space-y-2">
              <div className="max-w-3xl space-y-2">
                <div className="flex items-start gap-2">
                  <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      // Confirming an IME candidate is also an Enter.
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    disabled={busy}
                    rows={3}
                    placeholder={`Ask about ${chat.source}…`}
                    className="flex-1 min-w-0 text-xs px-2.5 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 placeholder:text-gray-400 dark:placeholder:text-gray-600 disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y leading-relaxed"
                  />
                  <button
                    onClick={busy ? stop : () => void send()}
                    disabled={!busy && !question.trim()}
                    className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-40 hover:opacity-80 flex-shrink-0"
                  >
                    {busy ? `stop · ${elapsed.toFixed(1)}s` : "Ask"}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  {config && (
                    <div className="flex items-center gap-2">
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        disabled={busy}
                        className="text-[10px] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1.5 py-0.5 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                      >
                        {config.models.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                      {(config.models.find((m) => m.id === model)?.effort ?? false) && (
                        <select
                          value={effort}
                          onChange={(e) => setEffort(e.target.value)}
                          disabled={busy}
                          className="text-[10px] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1.5 py-0.5 text-gray-600 dark:text-gray-400 disabled:opacity-50"
                        >
                          {config.efforts.map((e) => (
                            <option key={e} value={e}>{e} effort</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 dark:text-gray-600">
                    {lastTurn
                      ? [
                          `${lastTurn.steps} turn${lastTurn.steps === 1 ? "" : "s"}`,
                          `${tokens(
                            lastTurn.usage.input + lastTurn.usage.cacheRead + lastTurn.usage.cacheWrite,
                          )} in${lastTurn.usage.cacheRead ? ` (${tokens(lastTurn.usage.cacheRead)} cached)` : ""}`,
                          `${tokens(lastTurn.usage.output)} out`,
                          ...(lastTurn.costUsd != null ? [`~${money(lastTurn.costUsd)}`] : []),
                        ].join(" · ")
                      : "Enter to send · Shift+Enter for a new line"}
                  </p>
                </div>
              </div>
            </div>
            )}
          </>
        )}
      </main>

      {chat && showSchema && (
        <SchemaPanel
          source={chat.source}
          sources={sources}
          onSourceChange={() => {}}
          onClose={() => setShowSchema(false)}
        />
      )}
    </div>
  );
}

/** The + button: starting a chat means choosing what it is about, so the two are
    the same gesture. */
function NewChatButton({
  sources,
  onPick,
}: {
  sources: SourceOption[];
  onPick: (s: SourceOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const byDataset = new Map<string, SourceOption[]>();
  for (const s of sources) {
    const k = s.dataset ?? "";
    if (!byDataset.has(k)) byDataset.set(k, []);
    byDataset.get(k)!.push(s);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="New chat"
        className="text-sm w-6 h-6 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 leading-none"
      >
        +
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50 w-64 max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1">
            {sources.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-gray-400">No sources available.</p>
            ) : (
              [...byDataset].map(([ds, list]) => (
                <div key={ds}>
                  <div className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 truncate">
                    {ds || "other"}
                  </div>
                  {list.map((s) => (
                    <button
                      key={`${s.dataset}/${s.source}`}
                      onClick={() => {
                        setOpen(false);
                        void onPick(s);
                      }}
                      className="block w-full text-left pl-5 pr-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800/60"
                    >
                      <span className="block font-mono text-[11px] text-gray-800 dark:text-gray-200 truncate">
                        {s.source}
                      </span>
                      {s.description && (
                        <span className="block text-[10px] text-gray-400 dark:text-gray-500 leading-snug line-clamp-2">
                          {s.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
