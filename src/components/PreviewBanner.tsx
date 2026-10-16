// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The line across a page showing a BRANCH PREVIEW (src/lib/repo-previews.ts):
// which branch, which commit, how and when it was fetched — and that nobody
// else sees it, because it isn't published. Renders nothing for any other
// dataset address, so a page can include it unconditionally.

import { findPreview } from "@/lib/mcp-tools";
import { describeSnapshot, parsePreviewRef } from "@/lib/repo-previews";
import { qualifiedName } from "@/lib/repo-names";

export async function PreviewBanner({ userId, datasetRef, dashboard }: { userId: string; datasetRef: string; dashboard?: string }) {
  if (!parsePreviewRef(datasetRef)) return null;
  const r = await findPreview(userId, datasetRef);
  if (!r.ok) return null;
  const { revision, entry, isNew } = r.found.preview;
  const branch = revision.gitBranch ?? "";
  const github = r.found.ds.githubRepo;
  const published = qualifiedName(r.found.ref.split("@")[0], entry.name);
  return (
    <div
      role="status"
      className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <strong>Preview of branch {branch}</strong> — {describeSnapshot(revision)}. Not published: only admins can see
      it, and it changes only when the branch is fetched again.{" "}
      {github ? (
        <a className="underline" href={`https://github.com/${github}/tree/${encodeURIComponent(branch)}`} target="_blank" rel="noreferrer">
          Branch on GitHub
        </a>
      ) : null}
      {isNew ? (
        <span> · This dataset is new on the branch.</span>
      ) : (
        <>
          {" · "}
          <a
            className="underline"
            href={`/datasets/${encodeURIComponent(published)}${dashboard ? `/dashboard/${encodeURIComponent(dashboard)}` : ""}`}
          >
            Published version
          </a>
        </>
      )}
    </div>
  );
}
