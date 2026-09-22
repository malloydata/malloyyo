// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { dashboardSourceUrl } from "@/lib/github-source-link";
import { QueryIcon } from "@/components/QueryIcon";
import { DashboardTree } from "@/components/DashboardTree";

// The horizontal menu shared by a dataset's dashboard-style pages: the dashboard
// views and the AI Q&A page. It reads like:
//   <dataset / Dashboard a ▾> | [AI Q&A] [Query] [Chat]      [Explore in Claude]
// Every dashboard on every dataset lives in that first control (DashboardTree),
// which is a tree rather than a row of pills: one dataset's five dashboards
// already wrapped this bar onto three lines, and nothing in it could reach
// another dataset's dashboard in one hop. What stays in the bar is what ISN'T a
// dashboard — the ways into the data nobody built in advance.
export function DatasetNav({
  datasetId,
  activeDashboard,
  activeTitle,
  questionsActive = false,
}: {
  datasetId: string;
  /** The dashboard slug currently being viewed, if any. */
  activeDashboard?: string;
  /** Its title, for the tree's button — the page has already resolved it, and a
      draft's title lives in its own row rather than in the model's artifacts. */
  activeTitle?: string;
  /** True on the AI Q&A page. */
  questionsActive?: boolean;
}) {
  const [datasetName, setDatasetName] = useState("");
  // Git provenance, for the "view the source on GitHub" link.
  const [repo, setRepo] = useState<{
    datasetRepo: string | null;
    datasetBranch: string | null;
    gitRepo?: string | null;
    gitBranch?: string | null;
    gitSha?: string | null;
    gitDirty?: boolean | null;
    files?: { path: string }[] | null;
  } | null>(null);
  // For the "Query" item: ltool seeds a starter `run: <source> ->` from the
  // source it is handed. The dataset goes by NAME — /api/run resolves either.
  const [modelSources, setModelSources] = useState<string[]>([]);
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [claudeConnected, setClaudeConnected] = useState(false);
  // Chat needs an ANTHROPIC_API_KEY; without one the pill would go nowhere.
  const [chatEnabled, setChatEnabled] = useState(false);

  useEffect(() => {
    fetch(`/api/datasets/${datasetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) setDatasetName(d.name);
        if (Array.isArray(d?.malloyModel?.sources)) setModelSources(d.malloyModel.sources);
        if (d) {
          setRepo({
            datasetRepo: d.githubRepo ?? null,
            datasetBranch: d.githubBranch ?? null,
            gitRepo: d.malloyModel?.git?.repo ?? null,
            gitBranch: d.malloyModel?.git?.branch ?? null,
            gitSha: d.malloyModel?.git?.sha ?? null,
            gitDirty: d.malloyModel?.git?.dirty ?? null,
            files: d.malloyModel?.files ?? null,
          });
        }
      })
      .catch(() => {});
  }, [datasetId]);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.instanceName) setInstanceName(d.instanceName);
        if (typeof d?.claudeConnected === "boolean") setClaudeConnected(d.claudeConnected);
        if (typeof d?.askEnabled === "boolean") setChatEnabled(d.askEnabled);
      })
      .catch(() => {});
  }, []);

  // Seed a new Claude chat on this dataset (matches the home page's link). When
  // the connector isn't linked yet, send them to set it up.
  const onExploreClaude = () => {
    const url = claudeConnected
      ? `https://claude.ai/new?q=${encodeURIComponent(
          `Using the ${instanceName} Malloy tools, explore the "${datasetName || "dataset"}" dataset on ${instanceName} — list its sources and help me analyze it.`,
        )}`
      : "https://claude.ai/customize/connectors";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // The dashboard's own .malloy on GitHub — the demo point being that a
  // dashboard IS a source file. Null (so: not rendered) when the dataset has no
  // usable git provenance, or the dashboard has no file of its own.
  const sourceUrl = useMemo(
    () => (activeDashboard && repo ? dashboardSourceUrl({ name: activeDashboard, ...repo }) : null),
    [activeDashboard, repo],
  );

  // Active = the app's inverted black/white treatment (matches ltool's tabs),
  // not a colored accent — keeps the toolbar in the restrained gray palette.
  const pill = (active: boolean) =>
    `px-2.5 py-1 rounded-md transition-colors ${
      active
        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
        : "text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
    }`;

  return (
    <nav className="mb-4 flex items-center gap-2 flex-wrap rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40 px-2.5 py-1.5 font-mono text-xs">
      {/* Home + dataset name: where you are. */}
      <Link
        href="/"
        title="Home"
        className="flex items-center text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 px-1"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 9.5 12 3l9 6.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
      </Link>
      <DashboardTree
        currentDataset={datasetName || datasetId}
        activeDashboard={activeDashboard}
        activeLabel={questionsActive ? "AI Q&A" : activeTitle}
      />

      <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-700" />

      {/* What ISN'T a dashboard: the ways into the data nobody built in
          advance. The dashboards themselves are in the tree above. */}
      <div className="flex items-center gap-1 flex-wrap">
        <Link
          href={`/datasets/${encodeURIComponent(datasetName || datasetId)}/questions`}
          title="Questions asked and answered on this dataset"
          className={`inline-flex items-center gap-1 ${pill(questionsActive)}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2l1.6 4.9L18.5 8.5 13.6 10 12 15l-1.6-5L5.5 8.5l4.9-1.6L12 2z" />
          </svg>
          AI Q&amp;A
        </Link>
        {/* Write a query. Sits beside AI Q&A because they are the same kind of
            thing — a way into the data that isn't a dashboard someone built in
            advance. ltool takes the dataset by ID (the route param may be a
            name) and opens on a `run: <source> ->` starter, so passing the first
            source is what makes this land on a query rather than a blank picker. */}
        <Link
          href={`/ltool?${new URLSearchParams({
            dataset: datasetName || datasetId,
            ...(modelSources[0] ? { source: modelSources[0] } : {}),
          }).toString()}`}
          title="Write a Malloy query against this dataset in ltool"
          className={`inline-flex items-center gap-1 ${pill(false)}`}
        >
          <QueryIcon />
          Query
        </Link>
        {/* Chat belongs in this group for the same reason Query does: it is a way
            into the data that nobody built in advance. Same first source, so it
            opens in a conversation rather than in the source picker. */}
        {chatEnabled && (
          <Link
            href={`/chat?${new URLSearchParams({
              dataset: datasetName || datasetId,
              ...(modelSources[0] ? { source: modelSources[0] } : {}),
            }).toString()}`}
            title="Chat about this dataset"
            className={`inline-flex items-center gap-1 ${pill(false)}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
            </svg>
            Chat
          </Link>
        )}
      </div>

      {/* Right-hand group: where this came from, how it's set up, then the
          primary action. */}
      <div className="ml-auto flex items-center gap-1">
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`View ${activeDashboard}.malloy on GitHub — the dashboard's source`}
            className={`${pill(false)} inline-flex items-center gap-1.5`}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            source
          </a>
        )}
        <Link
          href={`/datasets/${encodeURIComponent(datasetName || datasetId)}/config`}
          title="Dataset configuration — model version, files, GitHub settings"
          className={`${pill(false)} inline-flex items-center gap-1.5`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          config
        </Link>
        <button
          onClick={onExploreClaude}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-black text-white dark:bg-white dark:text-black hover:opacity-85 whitespace-nowrap font-medium"
          title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
        >
          Explore in Claude
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
