// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The nav tree's shape and its filter — plain data, no React, so the matching
// rules can be tested directly rather than through a rendered menu.
//
// IN THE ENGINE because two things render this tree: the hosted app's React
// menu, and the dashboard switcher the CLI emits into `dashboard dev` and every
// static bundle. One filter, so "what does this search match" has one answer
// wherever you are looking at it.

export interface TreeDashboard {
  name: string;
  title: string;
  description?: string;
  isDraft?: boolean;
  author?: string;
  mine?: boolean;
}
export interface TreeDataset {
  dataset: string;
  dashboards: TreeDashboard[];
}

/** Datasets and dashboards whose name or title contains `q`. A dataset that
    matches by its own name keeps all of its dashboards — you searched for the
    dataset, so you want to see what is on it. */
export function filterTree(tree: TreeDataset[], q: string): TreeDataset[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return tree;
  const hit = (s: string) => s.toLowerCase().includes(needle);
  return tree
    .map((ds) =>
      hit(ds.dataset) ? ds : { ...ds, dashboards: ds.dashboards.filter((d) => hit(d.title) || hit(d.name)) },
    )
    .filter((ds) => ds.dashboards.length > 0 || hit(ds.dataset));
}
