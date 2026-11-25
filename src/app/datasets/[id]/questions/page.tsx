// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DatasetNav } from "@/components/DatasetNav";

// The AI Q&A page: every answered question asked against this dataset (by Claude,
// other models, or people in ltool), newest first. It sits in the dataset's
// dashboard-style nav and reads like a dashboard. Each question links to its
// saved answer (the ltool share page re-runs the query and shows the result).
type HistoryItem = {
  slug: string | null;
  question: string | null;
  createdAt: string;
  malloyQuery: string | null;
  rowCount: number | null;
  authorName: string | null;
  authorModel: string | null;
};

// A distinct question, latest answer first, with how many times it was asked.
type Question = HistoryItem & { askedCount: number };

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// author_model: "human" for people, else a model id ("claude-sonnet-5") or the
// generic "assistant". Render a compact badge; AI authors get the accent color.
function AuthorBadge({ model, name }: { model: string | null; name: string | null }) {
  const isHuman = !model || model === "human";
  if (isHuman) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
        {name || "human"}
      </span>
    );
  }
  const label = model === "assistant" ? "AI" : model;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-medium">
      {label}
    </span>
  );
}

export default function QuestionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [datasetName, setDatasetName] = useState("");
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [claudeConnected, setClaudeConnected] = useState(false);

  // Fetch-on-mount / refetch when the dataset changes; the async callback flips
  // loading and populates items.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/history?dataset=${id}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetch(`/api/datasets/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.name) setDatasetName(d.name); })
      .catch(() => {});
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.instanceName) setInstanceName(d.instanceName);
        if (typeof d?.claudeConnected === "boolean") setClaudeConnected(d.claudeConnected);
      })
      .catch(() => {});
  }, [id]);

  // Ask your own: open a Claude chat wired to this dataset over MCP. New questions
  // asked there land back on this page. When the connector isn't linked yet, send
  // them to set it up first.
  const onAskInClaude = () => {
    const url = claudeConnected
      ? `https://claude.ai/new?q=${encodeURIComponent(
          `Using the ${instanceName} Malloy tools, help me ask and answer analytical questions about the "${datasetName || "dataset"}" dataset on ${instanceName}.`,
        )}`
      : "https://claude.ai/customize/connectors";
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const askButton = (
    <button
      onClick={onAskInClaude}
      className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black hover:opacity-80 whitespace-nowrap"
      title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
    >
      Ask your own in Claude →
    </button>
  );

  // Collapse repeats: the same question re-run many times is one entry (keeping
  // the most recent answer), with a count. Rows arrive newest-first.
  const questions = useMemo<Question[]>(() => {
    const byText = new Map<string, Question>();
    for (const it of items) {
      const key = (it.question ?? it.malloyQuery ?? it.slug ?? "").trim().toLowerCase();
      if (!key) continue;
      const existing = byText.get(key);
      if (existing) existing.askedCount += 1;
      else byText.set(key, { ...it, askedCount: 1 });
    }
    return [...byText.values()];
  }, [items]);

  return (
    <main className="w-full px-6 py-5">
      <DatasetNav datasetId={id} questionsActive />

      <div className="rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Questions asked &amp; answered</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {loading
              ? "loading…"
              : questions.length === 0
                ? "No questions yet — be the first to ask."
                : `${questions.length} distinct question${questions.length === 1 ? "" : "s"} answered — click one to see the answer. Use “Explore in Claude” above to ask your own.`}
          </p>
        </div>

        {!loading && questions.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm text-gray-700 dark:text-gray-300 max-w-md mx-auto">
              Ask analytical questions of the <strong>{datasetName || "dataset"}</strong> data in plain
              language using Claude. Every question you ask over the {instanceName} connector is answered
              here — and shows up on this page for others to learn from.
            </p>
            <div className="mt-5 flex justify-center">{askButton}</div>
          </div>
        ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-900">
          {questions.map((q) => {
            const body = (
              <div className="group px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
                <p className="text-sm text-gray-800 dark:text-gray-200 leading-snug">
                  {q.question || <span className="font-mono text-xs text-gray-500">{q.malloyQuery}</span>}
                </p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap text-[11px] text-gray-400 dark:text-gray-500">
                  <AuthorBadge model={q.authorModel} name={q.authorName} />
                  {q.rowCount != null && <span>{q.rowCount.toLocaleString()} rows</span>}
                  {q.askedCount > 1 && <span>· asked {q.askedCount}×</span>}
                  <span>· {timeAgo(q.createdAt)}</span>
                  {q.slug && <span className="text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300 ml-auto">see answer →</span>}
                </div>
              </div>
            );
            return (
              <li key={q.slug ?? q.createdAt}>
                {q.slug ? <Link href={`/ltool/${q.slug}`}>{body}</Link> : body}
              </li>
            );
          })}
        </ul>
        )}
      </div>
    </main>
  );
}
