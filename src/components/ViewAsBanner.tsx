// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { VIEW_AS_MARKER_COOKIE } from "@/lib/view-as";

type ViewingAs = { name: string | null; email: string | null };

/**
 * The bar across every page while an admin is viewing as someone: who, that it
 * is look-only, and the way out.
 *
 * In the root layout, so no page can be the one that forgot it. It asks the
 * server who is being viewed as — the cookie that says so is HttpOnly — but
 * only when a readable marker says there is something to ask, so an ordinary
 * visitor's pages make no extra request. When the marker is gone, the bar goes.
 */
export function ViewAsBanner() {
  const pathname = usePathname();
  const [who, setWho] = useState<ViewingAs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // No marker cookie means nobody is being viewed as — including when a
    // view-as has just EXPIRED underneath this tab. That case must clear the
    // bar: left up, it would go on saying "look-only" over pages where the
    // admin is acting as themselves again.
    const marked = document.cookie.split("; ").some((c) => c.startsWith(`${VIEW_AS_MARKER_COOKIE}=1`));
    const asked: Promise<ViewingAs | null> = marked
      ? fetch("/api/me")
          .then((res) => (res.ok ? res.json() : null))
          .then((me: { viewingAs?: ViewingAs } | null) => me?.viewingAs ?? null)
          .catch(() => null)
      : Promise.resolve(null);
    void asked.then((viewingAs) => {
      if (live) setWho(viewingAs);
    });
    return () => {
      live = false;
    };
    // Re-asked on navigation: a view-as can end underneath the page (it
    // expires, or the person is disabled), and the bar should go with it.
  }, [pathname]);

  if (!who) return null;
  const name = who.name ?? who.email ?? "another user";

  async function stop() {
    setBusy(true);
    await fetch("/api/admin/view-as", { method: "DELETE" }).catch(() => {});
    // Back to where it was started, and by a full load for the same reason
    // starting is one: nothing built for the other person may survive.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load, deliberately; see above
    window.location.assign("/admin/users");
  }

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b-2 border-amber-700 bg-amber-200 px-6 py-2 text-sm text-amber-950"
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>
          <strong>Viewing as {name}</strong>
          {who.name && who.email ? ` (${who.email})` : ""}
        </span>
        <span className="text-xs">
          You see exactly what they see, and queries run as them. Nothing you do here is saved, and it is
          logged that you looked.
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void stop()}
        className="rounded bg-amber-950 px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {busy ? "Stopping…" : `Stop viewing as ${who.name?.split(/\s+/)[0] ?? "them"}`}
      </button>
    </div>
  );
}
