// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Who can open one dashboard, and the dialog that changes it.
//
// In the dataset nav, beside the dashboard's name: a one-line label of the
// current state, a Share button, and (for a draft) delete. The dialog is laid
// out the way a document-sharing dialog is, because that is the model people
// already carry: add people at the top, the people who have access in the
// middle, general access underneath.
//
//   Add people        by email address
//   People with access  the draft's author, Admins (always), then each person
//   General access    Restricted, or everyone who can open the dataset
//
// The same control for a draft and for a published dashboard — they behave the
// same, and promoting one into the other copies what is set here. Only who is
// shown it differs, and the server decides that (and re-checks every write):
// a draft's author or an admin; for a published dashboard, an admin.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LinkIcon, LockIcon, ShieldIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { datasetRefSegment } from "@/lib/dataset-ref-path";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Visibility = "private" | "dataset";
type Person = { id: string; email: string | null; name: string | null };
type SharedWith = Person & { canOpen: boolean };
type Sharing = {
  kind: "draft" | "published";
  visibility: Visibility;
  datasetTitle: string;
  author?: Person;
  people: SharedWith[];
};

const initials = (p: Person) =>
  (p.name ?? p.email ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Avatar({ children, tone }: { children: React.ReactNode; tone: "ink" | "muted" | "blue" }) {
  const tones = {
    ink: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
    muted: "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100",
    blue: "bg-blue-200 text-blue-950",
  };
  return (
    <span
      aria-hidden
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function DashboardShare({
  datasetRef,
  dashboard,
  title,
  kind,
  visibility: initialVisibility,
  datasetTitle,
  sharedCount,
  draftSlug,
}: {
  datasetRef: string;
  /** The name routes take for it (`draft-<slug>` for a draft). */
  dashboard: string;
  /** What to call it in the dialog's heading. */
  title: string;
  kind: "draft" | "published";
  visibility: Visibility;
  datasetTitle: string;
  /** How many people it is shared with, as the page counted them — what the
      label shows until the dialog has loaded the list itself. */
  sharedCount: number;
  /** Set for a draft, whose manager may also delete it. */
  draftSlug?: string;
}) {
  const router = useRouter();
  const ref = datasetRefSegment(datasetRef);
  const url = `/api/dashboards/${ref}/${encodeURIComponent(dashboard)}/sharing`;
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const visibility = sharing?.visibility ?? initialVisibility;
  const isPrivate = visibility === "private";
  const everyone = `Everyone on ${sharing?.datasetTitle ?? datasetTitle}`;
  const count = sharing?.people.length ?? sharedCount;

  // The people list arrives when the dialog is first opened. State is only set
  // from the response callbacks; a failed load is quiet, and the first write
  // will say what is wrong.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((out: { ok?: boolean; sharing?: Sharing } | null) => {
        if (live && out?.ok && out.sharing) setSharing(out.sharing);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, url]);

  /** One write. The server's answer is the new state, whole. */
  async function change(method: "PATCH" | "POST" | "DELETE", body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; sharing?: Sharing } | null;
    setBusy(false);
    if (!res.ok || !out?.ok || !out.sharing) {
      setError(out?.error ?? `request failed (${res.status})`);
      return false;
    }
    setSharing(out.sharing);
    return true;
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    if (await change("POST", { email: address })) setEmail("");
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(window.location.href.split("?")[0] ?? window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the link. Copy it from the address bar.");
    }
  }

  async function onDelete() {
    if (!draftSlug) return;
    if (!window.confirm("Delete this draft? Its link will stop working.")) return;
    setBusy(true);
    const res = await fetch(`/api/datasets/${ref}/drafts/${encodeURIComponent(draftSlug)}`, { method: "DELETE" });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !out?.ok) {
      setBusy(false);
      window.alert(out?.error ?? `delete failed (${res.status})`);
      return;
    }
    router.push(`/datasets/${ref}`);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden text-gray-600 dark:text-gray-400 sm:inline">
        {isPrivate ? `Private${count ? ` · shared with ${count}` : ""}` : everyone}
      </span>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // The nav's menus list what this person can see, and a change here
          // changes that for other people — refresh on the way out, so a page
          // rendered before the change is not what stays on screen.
          if (!next) router.refresh();
        }}
      >
        <DialogTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-gray-900 px-3 py-1 font-medium text-white hover:opacity-85 dark:bg-gray-100 dark:text-gray-900"
          >
            {isPrivate ? <LockIcon size={12} aria-hidden /> : <UsersIcon size={12} aria-hidden />}
            Share
          </button>
        </DialogTrigger>
        <DialogContent className="font-sans sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-sans text-lg font-medium">Share &ldquo;{title}&rdquo;</DialogTitle>
            <DialogDescription className="sr-only">
              Choose who can open this dashboard: add people by email address, or open it to everyone who can
              open the dataset.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={onAdd} className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Add people by email"
                aria-label="Add people by email"
                disabled={busy}
                className="min-w-0 flex-1 rounded-md border border-gray-500 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:bg-gray-950 dark:text-gray-100"
              />
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {error && <p className="text-sm font-medium text-red-800 dark:text-red-300">{error}</p>}
          </form>

          <div className="flex flex-col gap-1">
            <h3 className="mb-1 text-sm font-semibold">People with access</h3>
            {sharing?.author && (
              <div className="flex min-h-12 items-center gap-3">
                <Avatar tone="ink">{initials(sharing.author)}</Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{sharing.author.name ?? sharing.author.email}</span>
                  {sharing.author.name && sharing.author.email && (
                    <span className="block truncate text-xs text-gray-600 dark:text-gray-400">
                      {sharing.author.email}
                    </span>
                  )}
                </span>
                <span className="text-sm text-gray-600 dark:text-gray-400">Author</span>
              </div>
            )}
            <div className="flex min-h-12 items-center gap-3">
              <Avatar tone="muted">
                <ShieldIcon size={15} />
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Admins</span>
                <span className="block text-xs text-gray-600 dark:text-gray-400">
                  Everyone who administers this instance
                </span>
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-400">Always</span>
            </div>
            {sharing === null && <p className="py-2 text-sm text-gray-600 dark:text-gray-400">Loading…</p>}
            {sharing?.people.map((p) => (
              <div key={p.id} className="flex min-h-12 items-center gap-3">
                <Avatar tone="blue">{initials(p)}</Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{p.email ?? p.name}</span>
                  <span
                    className={`block text-xs ${
                      p.canOpen ? "text-gray-600 dark:text-gray-400" : "font-medium text-orange-900 dark:text-orange-300"
                    }`}
                  >
                    {p.canOpen
                      ? p.name && p.email
                        ? p.name
                        : "Can open it"
                      : `Cannot open ${sharing.datasetTitle} yet, so will not see this`}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void change("DELETE", { userId: p.id })}
                  aria-label={`Remove ${p.email ?? p.name ?? "this person"}`}
                  className="rounded-md border border-gray-300 px-2.5 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">General access</h3>
            <div className="flex items-center gap-3">
              <Avatar tone={isPrivate ? "muted" : "blue"}>
                {isPrivate ? <LockIcon size={15} /> : <UsersIcon size={15} />}
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <select
                  aria-label="General access"
                  value={visibility}
                  disabled={busy}
                  onChange={(e) => void change("PATCH", { visibility: e.target.value })}
                  className="max-w-full self-start rounded-md border border-gray-400 bg-white px-2 py-1.5 text-sm font-semibold text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="private">Restricted</option>
                  <option value="dataset">{everyone}</option>
                </select>
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {isPrivate
                    ? "Only the people listed above can open it."
                    : `Anyone who can open the ${sharing?.datasetTitle ?? datasetTitle} dataset can open it, and it is listed in their menu.`}
                </span>
              </span>
            </div>
          </div>

          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            <button
              type="button"
              onClick={() => void onCopy()}
              className="inline-flex items-center gap-2 rounded-full border border-gray-500 px-4 py-1.5 text-sm font-semibold text-blue-800 hover:bg-gray-50 dark:text-blue-300 dark:hover:bg-gray-800"
            >
              <LinkIcon size={14} aria-hidden />
              {copied ? "Link copied" : "Copy link"}
            </button>
            <DialogClose asChild>
              <button type="button" className="rounded-full bg-blue-700 px-5 py-1.5 text-sm font-semibold text-white">
                Done
              </button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {kind === "draft" && draftSlug ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDelete()}
          aria-label="Delete draft"
          title="Delete draft"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-gray-300 text-gray-700 hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Trash2Icon size={13} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
