// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Deletes a draft dashboard, after a confirm, then goes to its dataset. */
export function DeleteDraftButton({ datasetRef, slug }: { datasetRef: string; slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (!window.confirm("Delete this draft? Its link will stop working.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/datasets/${datasetRef}/drafts/${encodeURIComponent(slug)}`, { method: "DELETE" });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !out?.ok) {
      setBusy(false);
      setError(out?.error ?? `delete failed (${res.status})`);
      return;
    }
    router.push(`/datasets/${datasetRef}`);
    router.refresh();
  }

  return (
    <span className="ml-auto flex items-center gap-2">
      {error ? <span className="text-red-700 dark:text-red-300">{error}</span> : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950"
      >
        {busy ? "Deleting…" : "Delete draft"}
      </button>
    </span>
  );
}
