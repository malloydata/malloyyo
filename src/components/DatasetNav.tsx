// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

// A dataset the switcher can jump to, with the landing page it opens: its first
// dashboard, or the AI Q&A page when it has none.
type SwitchTarget = { datasetId: string; name: string; href: string };

// The horizontal menu shared by a dataset's dashboard-style pages: the dashboard
// views and the AI Q&A page. It reads like:
//   <dataset ▾> | [Dashboard a] [Dashboard b] … [AI Q&A]        [Explore in Claude]
// The dataset name is a switcher (jumps to another dataset's first page); the
// active item (a dashboard, or the Q&A page) is highlighted.
export function DatasetNav({
  datasetId,
  activeDashboard,
  questionsActive = false,
}: {
  datasetId: string;
  /** The dashboard slug currently being viewed, if any. */
  activeDashboard?: string;
  /** True on the AI Q&A page. */
  questionsActive?: boolean;
}) {
  const [datasetName, setDatasetName] = useState("");
  const [dashboards, setDashboards] = useState<{ name: string; title: string | null }[]>([]);
  const [instanceName, setInstanceName] = useState("Malloyyo");
  const [claudeConnected, setClaudeConnected] = useState(false);
  // Switcher: every visible dataset (from /api/sources, grouped) with its landing
  // page (first dashboard from /api/dashboards, else the Q&A page).
  const [sources, setSources] = useState<{ datasetId: string; model: string; status: string }[]>([]);
  const [allDashboards, setAllDashboards] = useState<{ datasetId: string; name: string }[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    fetch(`/api/datasets/${datasetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) setDatasetName(d.name);
        if (Array.isArray(d?.dashboards)) setDashboards(d.dashboards);
      })
      .catch(() => {});
  }, [datasetId]);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.instanceName) setInstanceName(d.instanceName);
        if (typeof d?.claudeConnected === "boolean") setClaudeConnected(d.claudeConnected);
      })
      .catch(() => {});
    fetch("/api/sources")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setSources(Array.isArray(d) ? d : []))
      .catch(() => {});
    fetch("/api/dashboards")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setAllDashboards(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  // One entry per visible, ready dataset — deduped from the flat sources list
  // (dataset name = model name, as the home page does), each pointing at its
  // first dashboard or, failing that, its AI Q&A page. Sorted by name.
  const switchTargets = useMemo<SwitchTarget[]>(() => {
    const firstDash = new Map<string, string>();
    for (const d of allDashboards) {
      if (!firstDash.has(d.datasetId)) firstDash.set(d.datasetId, d.name);
    }
    const seen = new Map<string, SwitchTarget>();
    for (const s of sources) {
      if (s.status !== "ready" || seen.has(s.datasetId)) continue;
      const dash = firstDash.get(s.datasetId);
      seen.set(s.datasetId, {
        datasetId: s.datasetId,
        name: s.model,
        // Link by dataset NAME (readable, resolves via findByDatasetRef), not the slug.
        href: dash
          ? `/datasets/${encodeURIComponent(s.model)}/dashboard/${encodeURIComponent(dash)}`
          : `/datasets/${encodeURIComponent(s.model)}/questions`,
      });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sources, allDashboards]);

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
      <div className="relative">
        <button
          onClick={() => setSwitcherOpen((o) => !o)}
          className="flex items-center gap-1 text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300"
          title="Switch dataset"
        >
          {datasetName || "dataset"}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-gray-400">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {switcherOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1">
              {switchTargets.length === 0 ? (
                <p className="px-3 py-1.5 text-gray-400">no datasets</p>
              ) : (
                switchTargets.map((t) => {
                  const current = t.datasetId === datasetId || t.name === datasetName;
                  return (
                    <Link
                      key={t.datasetId}
                      href={t.href}
                      onClick={() => setSwitcherOpen(false)}
                      className={`block px-3 py-1.5 truncate hover:bg-gray-100 dark:hover:bg-gray-800/60 ${
                        current ? "font-semibold text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-900" : "text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {t.name}
                    </Link>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-700" />

      {/* The dataset's pages: dashboards, then the AI Q&A. */}
      <div className="flex items-center gap-1 flex-wrap">
        {dashboards.map((d) => (
          <Link
            key={d.name}
            // Link by dataset NAME (readable, resolves via findByDatasetRef) once
            // known; fall back to the incoming ref until the name loads.
            href={`/datasets/${encodeURIComponent(datasetName || datasetId)}/dashboard/${encodeURIComponent(d.name)}`}
            title={d.title ?? d.name}
            className={pill(d.name === activeDashboard)}
          >
            {d.title ?? d.name}
          </Link>
        ))}
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
      </div>

      {/* Primary action — open this dataset in Claude. */}
      <button
        onClick={onExploreClaude}
        className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-black text-white dark:bg-white dark:text-black hover:opacity-85 whitespace-nowrap font-medium"
        title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
      >
        Explore in Claude
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      </button>
    </nav>
  );
}
