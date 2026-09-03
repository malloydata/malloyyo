// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Rendering a conversation. The stored form is the model's — an array of
// Anthropic content blocks per message — so this is the translation from what
// the API said to what a person reads.
//
// Thinking blocks are not shown. They are returned empty unless the request asks
// for summaries, and an empty disclosure that never has anything in it is worse
// than no disclosure.

import dynamic from "next/dynamic";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MalloyResultView = dynamic(
  () => import("@/components/MalloyResultView").then((m) => m.MalloyResultView),
  {
    ssr: false,
    loading: () => (
      <div className="h-24 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 animate-pulse" />
    ),
  },
);

/** One stored message, as `/api/chats/[id]` returns it. */
export type StoredMessage = { role: string; content: unknown };

/** A rendered result, keyed by the tool_use id that produced it. */
export type StoredResult = {
  toolUseId: string;
  malloy: string | null;
  sql: string | null;
  rowCount: number | null;
  slug: string | null;
  stableResult: unknown;
};

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: Array<{ text?: string }>;
};

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Prose. `prose-sm` with tight spacing — a chat is read in a narrow column, and
    default markdown margins make three sentences look like a document. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed space-y-2 [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-gray-100 dark:[&_code]:bg-gray-800 [&_code]:px-1 [&_code]:rounded [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_strong]:font-semibold">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/** A query the model ran: the Malloy, collapsed, with its result beneath.
 *
 * Collapsed by default because the answer is the point and the Malloy is the
 * working — but one click away, because a query you cannot inspect is one you
 * cannot trust or reuse. */
function QueryCard({
  input,
  result,
  dataset,
}: {
  input: Record<string, unknown>;
  result?: StoredResult;
  dataset: string;
}) {
  const [open, setOpen] = useState(false);
  const malloy = (result?.malloy ?? (typeof input.malloy === "string" ? input.malloy : "")) || "";
  const question = typeof input.question === "string" ? input.question : "";
  const rows = result?.rowCount;

  return (
    <div className="space-y-2">
      <div className="rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-baseline gap-2 text-left px-2.5 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-900/50"
        >
          <span className="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 dark:text-gray-600 flex-shrink-0">
            Malloy
          </span>
          <span className="text-[11px] font-mono text-gray-600 dark:text-gray-400 truncate flex-1">
            {question || malloy.replace(/\s+/g, " ").trim()}
          </span>
          {rows != null && (
            <span className="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0">
              {rows.toLocaleString()} rows
            </span>
          )}
        </button>
        {open && (
          <pre className="px-2.5 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-auto whitespace-pre text-[11px] font-mono text-gray-700 dark:text-gray-300">
            {malloy}
          </pre>
        )}
      </div>

      {result?.stableResult ? (
        <>
          <MalloyResultView
            stableResult={result.stableResult as Record<string, unknown>}
            datasetRef={dataset}
            variant="transcript"
            // The docs site guesses this per query by hand; here the row count is
            // the only signal available, and it is a decent one — a five-row
            // answer wants a small box, a hundred-row one wants room to scroll.
            size={rows == null || rows <= 12 ? "small" : rows <= 60 ? "medium" : "large"}
          />
          {result.slug && (
            <a
              href={`/ltool/${result.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              ↗ open in ltool
            </a>
          )}
        </>
      ) : null}
    </div>
  );
}

/** A tool that isn't a query — describe_source, yo_help, or a validate. Shown as
    a line rather than a card: it is how the model got somewhere, not a result. */
function ToolLine({ name, ok }: { name: string; ok: boolean }) {
  return (
    <p className="text-[11px] text-gray-400 dark:text-gray-600">
      {ok ? "✓" : "✕"} {name}
    </p>
  );
}

export function ChatMessages({
  messages,
  results,
  dataset,
}: {
  messages: StoredMessage[];
  results: StoredResult[];
  dataset: string;
}) {
  const byId = new Map(results.map((r) => [r.toolUseId, r]));
  // Which tool calls failed, so a non-query tool can be marked without hunting
  // through the following user message at render time.
  const errored = new Set<string>();
  for (const m of messages) {
    for (const b of blocks(m.content)) {
      if (b.type === "tool_result" && b.is_error && b.tool_use_id) errored.add(b.tool_use_id);
    }
  }

  return (
    <div className="space-y-5">
      {messages.map((m, i) => {
        const bs = blocks(m.content);

        if (m.role === "user") {
          // A user message is either what they typed or a batch of tool results.
          // The latter is bookkeeping the model needs and nobody wants to read.
          const text = bs.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
          if (!text) return null;
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm whitespace-pre-wrap">
                {text}
              </div>
            </div>
          );
        }

        const parts = bs.filter((b) => b.type === "text" || b.type === "tool_use");
        if (parts.length === 0) return null;

        return (
          <div key={i} className="space-y-3">
            {parts.map((b, j) => {
              if (b.type === "text") {
                return b.text?.trim() ? <Markdown key={j} text={b.text} /> : null;
              }
              const id = b.id ?? "";
              if (b.name === "query" && b.input?.execute !== false) {
                return (
                  <QueryCard key={j} input={b.input ?? {}} result={byId.get(id)} dataset={dataset} />
                );
              }
              return <ToolLine key={j} name={b.name ?? "tool"} ok={!errored.has(id)} />;
            })}
          </div>
        );
      })}
    </div>
  );
}
