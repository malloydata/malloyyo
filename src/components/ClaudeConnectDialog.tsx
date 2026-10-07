// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState } from "react";

// "Connect <instance> to Claude first": the one-time setup a claude.ai chat
// needs before it can see this instance. Shown by the dataset toolbar's
// "Explore in Claude" and the AI Q&A page's "Ask your own in Claude" when the
// user has no live connector, instead of opening claude.ai's Connectors page
// bare — that page has no entry for this instance, and nothing on it says the
// address to add is this origin plus `/mcp`. Same steps as ltool's
// "Explore further with Claude" setup and the front page's McpSetup.
export function ClaudeConnectDialog({
  instanceName,
  continueUrl,
  onClose,
}: {
  instanceName: string;
  /** The seeded claude.ai chat to open once the connector is added. */
  continueUrl: string;
  onClose: () => void;
}) {
  const [origin, setOrigin] = useState("");
  // window.location is browser-only; read it after mount so SSR and the first
  // client render agree.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const mcpUrl = `${origin}/mcp`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${instanceName} to Claude`}
        className="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-md w-full p-5 space-y-4 font-mono text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">Connect {instanceName} to Claude first</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 leading-none"
            title="Close"
          >
            ×
          </button>
        </div>

        <p className="text-gray-600 dark:text-gray-400">
          Claude can only explore this data through a connector to {instanceName}. One-time setup:
        </p>

        <ol className="list-decimal list-inside text-gray-700 dark:text-gray-300 space-y-2">
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

        <div className="space-y-1.5 pl-4">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400 w-12 flex-shrink-0">Name</span>
            <code className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-0.5 flex-1 truncate">{instanceName}</code>
            <CopyChip value={instanceName} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400 w-12 flex-shrink-0">URL</span>
            <code className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-0.5 flex-1 truncate">{mcpUrl}</code>
            <CopyChip value={mcpUrl} />
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            The URL ends in <code>/mcp</code>; the address in the browser bar on its own does not work.
          </p>
        </div>

        <ol className="list-decimal list-inside text-gray-700 dark:text-gray-300 space-y-2" start={3}>
          <li>Sign in to {instanceName} when claude.ai asks, and approve access</li>
        </ol>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => {
              window.open(continueUrl, "_blank", "noopener,noreferrer");
              onClose();
            }}
            className="px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black hover:opacity-80"
          >
            Continue on to Claude.ai →
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
          >
            Cancel
          </button>
        </div>
      </div>
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
