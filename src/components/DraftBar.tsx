// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The line across a DRAFT dashboard's page: that it is a draft, what it was
// promoted as (it forwards there once that dashboard is published), and —
// for its author or an admin — Delete.

import { isAdmin } from "@/lib/admin";
import type { User } from "@/db";
import { DeleteDraftButton } from "./DeleteDraftButton";

export function DraftBar({
  user,
  datasetRef,
  slug,
  authorId,
  promotedAs,
}: {
  user: User;
  datasetRef: string;
  slug: string;
  authorId: string;
  promotedAs: string | null;
}) {
  const canDelete = authorId === user.id || isAdmin(user);
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <span>
        <strong>Draft</strong>
        {promotedAs ? (
          <>
            {" "}— promoted as <code>{promotedAs}</code>. This link will open that dashboard once the model
            carrying it is published.
          </>
        ) : (
          <> — not part of the model yet. Anyone who can see this dataset can open it.</>
        )}
      </span>
      {canDelete ? <DeleteDraftButton datasetRef={datasetRef} slug={slug} /> : null}
    </div>
  );
}
