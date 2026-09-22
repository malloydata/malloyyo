// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { filterTree, type TreeDashboard, type TreeDataset } from "@/lib/dashboard-tree";

/**
 * One control for "which dashboard am I looking at, and what else is there" —
 * every dataset and every dashboard on this instance, in a tree.
 *
 * It replaces a row of pills, one per dashboard on the current dataset, plus a
 * separate dataset switcher and a separate "user dashboards" menu. That bar
 * didn't scale: five dashboards already wrapped it onto three lines, and
 * nothing on it could reach another dataset's dashboard without two hops.
 *
 * The shape follows the data. A dataset is a branch, its dashboards are leaves,
 * the model's own come before the ones people made, and a single-dataset
 * instance has no branches worth drawing — so it gets the flat list it would
 * have had anyway.
 */

export function DashboardTree({
  currentDataset,
  activeDashboard,
  activeLabel,
}: {
  /** The dataset being viewed — its branch opens first. */
  currentDataset: string;
  /** The dashboard slug being viewed, if any: the highlighted leaf. */
  activeDashboard?: string;
  /** What to show beside the dataset name on the button. */
  activeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<TreeDataset[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetched when it is first opened, not on mount: this walks every visible
  // dataset, and a dashboard page should not wait on a menu nobody clicked.
  useEffect(() => {
    if (!open || tree) return;
    fetch("/api/dashboards?tree=1")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rows: TreeDataset[]) => setTree(Array.isArray(rows) ? rows : []))
      .catch(() => setFailed(true));
  }, [open, tree]);

  // Opening starts on the dataset you are looking at; closing forgets the
  // search, so the next open is the whole tree again. Both in the handlers
  // rather than an effect on `open` — there is nothing external to sync to.
  const openMenu = () => {
    setExpanded(new Set([currentDataset]));
    setOpen(true);
  };
  const closeMenu = () => {
    setQuery("");
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const shown = useMemo(() => filterTree(tree ?? [], query), [tree, query]);
  // One dataset is not a tree. Judged on the WHOLE tree, never on what a search
  // left behind: a filter that happens to match one dataset must still say
  // which one, or the results are five titles floating with no owner.
  const flat = (tree?.length ?? 0) === 1;
  // While searching, everything that survived the filter is open — hiding a
  // match behind a closed branch is the one thing a search must not do.
  const isOpen = (name: string) => flat || query.trim() !== "" || expanded.has(name);

  const leaf = (dataset: string, d: TreeDashboard) => {
    const active = d.name === activeDashboard && dataset === currentDataset;
    return (
      <Link
        key={`${dataset}/${d.name}`}
        href={`/datasets/${encodeURIComponent(dataset)}/dashboard/${encodeURIComponent(d.name)}`}
        onClick={closeMenu}
        title={d.description}
        className={`flex items-center gap-2 rounded px-2 py-1 ${flat ? "" : "ml-4"} ${
          active
            ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
            : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/60"
        }`}
      >
        <span className="truncate">{d.title}</span>
        {d.isDraft && !d.mine && d.author && (
          <span className={`ml-auto shrink-0 text-[10px] ${active ? "opacity-70" : "text-gray-400 dark:text-gray-500"}`}>
            {d.author.split(/\s+/)[0]}
          </span>
        )}
      </Link>
    );
  };

  const group = (ds: TreeDataset) => {
    const own = ds.dashboards.filter((d) => !d.isDraft);
    const user = ds.dashboards.filter((d) => d.isDraft);
    return (
      <>
        {own.map((d) => leaf(ds.dataset, d))}
        {user.length > 0 && (
          <p className={`${flat ? "" : "ml-4"} px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500`}>
            user dashboards
          </p>
        )}
        {user.map((d) => leaf(ds.dataset, d))}
        {ds.dashboards.length === 0 && (
          <Link
            href={`/datasets/${encodeURIComponent(ds.dataset)}`}
            onClick={closeMenu}
            className={`${flat ? "" : "ml-4"} block rounded px-2 py-1 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800/60`}
          >
            no dashboards — open dataset
          </Link>
        )}
      </>
    );
  };

  return (
    <div className="relative">
      <button
        onClick={() => (open ? closeMenu() : openMenu())}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex max-w-[60vw] items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-white dark:hover:bg-gray-800"
        title="All datasets and dashboards"
      >
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{currentDataset || "dataset"}</span>
        {activeLabel && (
          <>
            <span className="text-gray-300 dark:text-gray-600">/</span>
            <span className="truncate text-gray-600 dark:text-gray-300">{activeLabel}</span>
          </>
        )}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-gray-400">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeMenu} />
          <div className="absolute left-0 top-full z-50 mt-1 w-[340px] rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg">
            {(tree?.length ?? 0) > 1 && (
              <div className="border-b border-gray-100 dark:border-gray-900 p-1.5">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter…"
                  className="w-full rounded bg-gray-50 dark:bg-gray-900 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none"
                />
              </div>
            )}
            <div className="max-h-[60vh] overflow-y-auto p-1">
              {failed ? (
                <p className="px-2 py-1.5 text-gray-400">couldn&apos;t load the dashboards</p>
              ) : !tree ? (
                <p className="px-2 py-1.5 text-gray-400">loading…</p>
              ) : shown.length === 0 ? (
                <p className="px-2 py-1.5 text-gray-400">
                  {query.trim() ? "nothing matches" : "no datasets"}
                </p>
              ) : (
                shown.map((ds) =>
                  flat ? (
                    <div key={ds.dataset}>{group(ds)}</div>
                  ) : (
                    <div key={ds.dataset}>
                      <div className="flex items-center">
                        <button
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(ds.dataset)) next.delete(ds.dataset);
                              else next.add(ds.dataset);
                              return next;
                            })
                          }
                          aria-expanded={isOpen(ds.dataset)}
                          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800/60"
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                            className={`shrink-0 text-gray-400 transition-transform ${isOpen(ds.dataset) ? "rotate-90" : ""}`}
                          >
                            <path d="M9 6l6 6-6 6" />
                          </svg>
                          <span
                            className={`truncate ${
                              ds.dataset === currentDataset
                                ? "font-semibold text-gray-900 dark:text-gray-100"
                                : "text-gray-700 dark:text-gray-300"
                            }`}
                          >
                            {ds.dataset}
                          </span>
                          <span className="ml-auto shrink-0 pl-2 text-[10px] text-gray-400">
                            {ds.dashboards.length || ""}
                          </span>
                        </button>
                      </div>
                      {isOpen(ds.dataset) && group(ds)}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
