// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Who sees one dashboard, for the person who may change it: a draft's author,
// or an admin. Rendered inside the bar across a draft's page (DraftBar) and a
// private modeled dashboard's (PrivateDashboardBar); the server decides who is
// shown it, and /sharing re-checks every write.
//
// Two controls, and only the second is shared by both kinds of dashboard:
//   • a draft is opened to its dataset or closed again (a modeled dashboard's
//     privacy is a tag in the model, so there is nothing to toggle here);
//   • a private dashboard is shared with people, one address at a time.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { datasetRefSegment } from "@/lib/dataset-ref-path";

type Visibility = "private" | "dataset";
type Person = { id: string; email: string | null; name: string | null };
type Sharing = { kind: "draft" | "modeled"; isPrivate: boolean; visibility?: Visibility; people: Person[]; warning?: string };

export function DashboardSharing({
  datasetRef,
  dashboard,
  kind,
  visibility: initialVisibility,
}: {
  datasetRef: string;
  dashboard: string;
  kind: "draft" | "modeled";
  /** A draft's current setting; a modeled dashboard shown here is private. */
  visibility: Visibility;
}) {
  const router = useRouter();
  const url = `/api/dashboards/${datasetRefSegment(datasetRef)}/${encodeURIComponent(dashboard)}/sharing`;
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(method: "PATCH" | "POST" | "DELETE", body?: unknown): Promise<Sharing | null> {
    const res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; sharing?: Sharing } | null;
    if (!res.ok || !out?.ok || !out.sharing) {
      setError(out?.error ?? `request failed (${res.status})`);
      return null;
    }
    return out.sharing;
  }

  /** One write: busy while it runs, and the server's answer is the new state. */
  async function change(method: "PATCH" | "POST" | "DELETE", body: unknown): Promise<Sharing | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const sharing = await call(method, body);
    setBusy(false);
    if (!sharing) return null;
    setPeople(sharing.people);
    if (sharing.visibility) setVisibility(sharing.visibility);
    setNotice(sharing.warning ?? null);
    return sharing;
  }

  // The people list, on arrival. Written as its own fetch rather than through
  // `call`: state is only ever set from the response callbacks, and a failed
  // load is quiet here — the first write will say what is wrong.
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((out: { ok?: boolean; sharing?: Sharing } | null) => {
        if (live) setPeople(out?.ok && out.sharing ? out.sharing.people : []);
      })
      .catch(() => {
        if (live) setPeople([]);
      });
    return () => {
      live = false;
    };
  }, [url]);

  async function onVisibility(next: Visibility) {
    if (next === visibility) return;
    // Refreshed so the bar's own sentence, rendered on the server, follows.
    if (await change("PATCH", { visibility: next })) router.refresh();
  }

  async function onShare(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    if (await change("POST", { email: address })) setEmail("");
  }

  const isPrivate = visibility === "private";
  const field =
    "rounded border border-slate-300 bg-white px-2 py-0.5 text-sm text-slate-900 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100";

  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      {kind === "draft" ? (
        <label className="flex items-center gap-2">
          <span className="text-slate-600 dark:text-slate-400">Who can open it</span>
          <select
            value={visibility}
            disabled={busy}
            onChange={(e) => void onVisibility(e.target.value as Visibility)}
            className={field}
          >
            {/* Worded for both readers of this control: the draft's author,
                and an admin looking at someone else's. */}
            <option value="private">Only its author, admins and people added here</option>
            <option value="dataset">Anyone who can open this dataset</option>
          </select>
        </label>
      ) : null}

      {isPrivate ? (
        <>
          <span className="text-slate-600 dark:text-slate-400">Shared with</span>
          {people === null ? (
            <span className="text-slate-500">…</span>
          ) : people.length === 0 ? (
            <span className="text-slate-500">nobody yet</span>
          ) : (
            people.map((p) => (
              <span
                key={p.id}
                title={p.name ?? undefined}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pl-2 pr-1 dark:border-slate-600 dark:bg-slate-950"
              >
                {p.email ?? p.name ?? "unknown"}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void change("DELETE", { userId: p.id })}
                  aria-label={`Stop sharing with ${p.email ?? p.name ?? "this person"}`}
                  className="rounded-full px-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                >
                  ×
                </button>
              </span>
            ))
          )}
          <form onSubmit={onShare} className="flex items-center gap-1.5">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              aria-label="Email address to share with"
              disabled={busy}
              className={`${field} w-52`}
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="rounded border border-slate-400 px-2 py-0.5 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-500 dark:hover:bg-slate-800"
            >
              Share
            </button>
          </form>
        </>
      ) : null}

      {error ? <span className="w-full text-red-700 dark:text-red-300">{error}</span> : null}
      {notice ? <span className="w-full text-amber-800 dark:text-amber-300">{notice}</span> : null}
    </div>
  );
}
