// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where `/datasets/<ref>` sends a reader.
//
// The dataset root used to be the CONFIG page — model version, files, GitHub
// settings. That is the operator's view, and it was the first thing anyone
// following a dataset link saw. The reader's view is whatever the dataset
// actually offers, in the order a newcomer needs it, so config moved to
// `/datasets/<ref>/config` and this decides the landing.
//
// The order is a fallback chain, not a preference list: each step exists because
// the one before it may have nothing to show.
//
//   1. The first dashboard. listDashboards puts the About page first when the
//      repo ships one, so this IS "the introduction, if there is one" — and
//      otherwise it is the dataset's most prominent view.
//   2. AI Q&A, when questions have been asked. A dataset with no dashboards can
//      still have a rich history of answered questions.
//   3. ltool, with the first source selected. A dataset with neither is not
//      broken, it is EMPTY — and the useful thing to hand someone then is a
//      query surface pointed at its data, not an empty list.
//
// Kept as a pure function so the chain is testable without a database; the page
// does the I/O and calls this.

/** What the dataset has to offer, as far as the landing decision cares. */
export interface DatasetLandingInput {
  /** Dashboards in nav order (About first, when present). */
  dashboards: readonly { name: string }[];
  /** Whether any question has been answered against this dataset. */
  hasQuestions: boolean;
  /** The model's first source, for ltool's initial selection. */
  firstSource?: string | null;
}

/**
 * The path `/datasets/<ref>` should redirect to.
 *
 * `ref` is whatever the URL carried — a name or an id — so the redirect keeps
 * the reader on the readable form they arrived with instead of swapping a name
 * for a uuid in the address bar.
 */
export function datasetLandingPath(ref: string, input: DatasetLandingInput): string {
  const base = `/datasets/${encodeURIComponent(ref)}`;

  const first = input.dashboards[0];
  if (first) return `${base}/dashboard/${encodeURIComponent(first.name)}`;

  if (input.hasQuestions) return `${base}/questions`;

  // ltool takes the dataset by ref — the same readable name the reader arrived
  // with, since /api/run resolves either that or an id. Selecting the first
  // source matters more than it looks: ltool with no source is a blank picker,
  // which is the same dead end the config page was.
  const params = new URLSearchParams({ dataset: ref });
  if (input.firstSource) params.set("source", input.firstSource);
  return `/ltool?${params.toString()}`;
}
