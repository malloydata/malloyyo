// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

import { useState } from "react";

/**
 * "View as" beside a person on Admin → Roles: start seeing the app exactly as
 * they do, and go to their home page. Stopping is the banner's job
 * (ViewAsBanner), which is on every page from then on.
 *
 * A full navigation rather than a client one, on purpose: every cached page and
 * every fetched list in this tab was built for the admin, and a view-as that
 * showed any of it would be showing the wrong person's app.
 */
export function ViewAsButton({ userId, label }: { userId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !out?.ok) {
      setBusy(false);
      setError(out?.error ?? `failed (${res.status})`);
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load, deliberately; see above
    window.location.assign("/");
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void start()}
        title={`See the app exactly as ${label} sees it`}
        className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
      >
        {busy ? "Opening…" : "View as"}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
