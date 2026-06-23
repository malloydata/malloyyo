// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState } from "react";
import CodeMirror, {
  EditorView,
  type Extension,
} from "@uiw/react-codemirror";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

// Malloy is SQL-shaped enough that CodeMirror's SQL highlighter covers ~80%
// of tokens. Augment with Malloy-specific reserved words.
const MALLOY_KEYWORDS = [
  "source", "measure", "dimension", "view", "query", "extend",
  "run", "aggregate", "group_by", "order_by", "calculate", "nest",
  "select", "where", "having", "limit", "top",
  "join_one", "join_many", "join_cross", "with", "on",
  "is", "primary_key", "rename", "import",
  "pick", "when", "else", "then",
  "year", "quarter", "month", "week", "day", "hour", "minute", "second",
  "true", "false", "null",
  "count", "sum", "avg", "min", "max",
].join(" ");

const malloyDialect = SQLDialect.define({
  keywords: MALLOY_KEYWORDS,
  operatorChars: "+-*/<>=!~&|.:",
});

const baseExtensions: Extension[] = [
  sql({ dialect: malloyDialect, upperCaseKeywords: false }),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { fontSize: "12px" },
    ".cm-content": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace" },
    ".cm-gutters": { backgroundColor: "transparent", borderRight: "none" },
  }),
];

export function MalloyCodeEditor({
  value,
  onChange,
  minHeight = "200px",
}: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: string;
}) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    // Initial read of a browser-only media query; the subscription below keeps it current.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={isDark ? oneDark : undefined}
        extensions={baseExtensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          dropCursor: false,
        }}
        minHeight={minHeight}
      />
    </div>
  );
}
