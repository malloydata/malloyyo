// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The line across a DRAFT dashboard's page: that it is a draft, who can open
// it, what it was promoted as (it forwards there once that dashboard is
// published), and — for its author or an admin — the controls that change who
// sees it, and Delete.

import { isAdmin } from "@/lib/admin";
import type { DraftVisibility, User } from "@/db";
import { DashboardSharing } from "./DashboardSharing";
import { DeleteDraftButton } from "./DeleteDraftButton";

export const BAR_CLASS =
  "mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

export function DraftBar({
  user,
  datasetRef,
  slug,
  dashboard,
  authorId,
  promotedAs,
  visibility,
}: {
  user: User;
  datasetRef: string;
  slug: string;
  /** The name routes take for it: `draft-<slug>`. */
  dashboard: string;
  authorId: string;
  promotedAs: string | null;
  visibility: DraftVisibility;
}) {
  // One rule for both: whoever may delete it may decide who sees it.
  const canManage = authorId === user.id || isAdmin(user);
  const isPrivate = visibility === "private";
  return (
    <div role="status" className={BAR_CLASS}>
      <span>
        <strong>Draft</strong>
        {promotedAs ? (
          <>
            {" "}— promoted as <code>{promotedAs}</code>. This link will open that dashboard once the model
            carrying it is published.
          </>
        ) : isPrivate ? (
          canManage ? (
            <> — private. Not part of the model yet, and not listed to anyone else on this dataset.</>
          ) : (
            <> — private, and shared with you. Not part of the model yet.</>
          )
        ) : (
          <> — not part of the model yet. Anyone who can see this dataset can open it.</>
        )}
      </span>
      {canManage ? <DeleteDraftButton datasetRef={datasetRef} slug={slug} /> : null}
      {canManage ? (
        <DashboardSharing datasetRef={datasetRef} dashboard={dashboard} kind="draft" visibility={visibility} />
      ) : null}
    </div>
  );
}

/**
 * The same line for a MODELED dashboard tagged `# artifact { private }` —
 * shown to admins only, because they are the ones who can act on it. Someone
 * it was shared with just sees a dashboard.
 */
export function PrivateDashboardBar({ datasetRef, dashboard }: { datasetRef: string; dashboard: string }) {
  return (
    <div role="status" className={BAR_CLASS}>
      <span>
        <strong>Private</strong> — the model tags this dashboard <code>private</code>, so it is listed to admins and
        the people below, not to everyone on the dataset. They still need a role that opens the dataset.
      </span>
      <DashboardSharing datasetRef={datasetRef} dashboard={dashboard} kind="modeled" visibility="private" />
    </div>
  );
}
