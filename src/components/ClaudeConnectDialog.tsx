// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState, type ReactNode } from "react";

/** A new claude.ai chat with `prompt` already typed in. */
export function claudeChatUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}

/** The prompt for exploring a whole dataset (home page card, dataset toolbar). */
export function exploreDatasetPrompt(instanceName: string, dataset: string): string {
  return `Using the ${instanceName} Malloy tools, explore the "${dataset}" dataset on ${instanceName} — list its sources and help me analyze it.`;
}

// Every Claude button goes through this: open the seeded chat when claude.ai is
// connected, otherwise show the dialog first. Render `connectDialog` once.
export function useClaudeConnect(instanceName: string, claudeConnected: boolean, setupBody?: ReactNode) {
  const [target, setTarget] = useState<string | null>(null);
  const openClaude = (url: string) => {
    if (claudeConnected) window.open(url, "_blank", "noopener,noreferrer");
    else setTarget(url);
  };
  const connectDialog = target ? (
    <ClaudeConnectDialog instanceName={instanceName} continueUrl={target} onClose={() => setTarget(null)}>
      {setupBody}
    </ClaudeConnectDialog>
  ) : null;
  return { openClaude, connectDialog };
}

// "Connect <instance> to Claude first": the one-time setup, including the
// `<origin>/mcp` address claude.ai's Connectors page never shows. The home page
// passes its fuller McpSetup as `children` in place of the short steps.
export function ClaudeConnectDialog({
  instanceName,
  continueUrl,
  onClose,
  children,
}: {
  instanceName: string;
  /** The seeded claude.ai chat to open once the connector is added. */
  continueUrl: string;
  onClose: () => void;
  /** Replaces the default short steps (the front page shows its full McpSetup). */
  children?: ReactNode;
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
        className={`bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl w-full p-5 space-y-4 text-xs ${children ? "max-w-lg max-h-[85vh] overflow-y-auto" : "max-w-md font-mono"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">Connect {instanceName} to Claude first</h2>
          <button
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 leading-none"
            title="Close"
          >
            ×
          </button>
        </div>

        {children ?? (<>
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
        </>)}

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
