// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Admin → Users → Add user: an address, and the roles that person starts with.
//
// It creates the person — a real user, from this moment (src/lib/roster.ts):
// they are in the list at once, their roles can be changed, a dashboard can be
// shared with them, and they can be impersonated to see what they will find.
// Their first sign-in with that address makes the row theirs.
//
// It is also the one place a person and their roles are decided together.
// Before this, an address was invited as "member" or "admin", signed in to
// whatever the instance gave new users, and was given what they actually needed
// afterwards — so the first thing most people saw was an empty page. Here the roles are ticked up front, with what they add up to
// worked out before anything is saved (the same arithmetic as the list behind
// it, src/lib/role-access.ts).
//
// The roles new users are given are ticked to begin with, so adding someone
// without touching the boxes does what it always did.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resolveAccess } from "@/lib/role-access";
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
import { ADMIN, AccessSummary, describeRole, MUTED, PRIMARY, type DatasetRow, type RoleRow } from "../access-shared";
import { BTN } from "../roles/role-controls";

/** "a@x.com, b@y.com" or one per line → the addresses, in order, once each. */
function addressesIn(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

export function AddUserButton({
  roles,
  datasets,
  defaults,
  cannotClaim = [],
}: {
  roles: RoleRow[];
  datasets: DatasetRow[];
  /** The roles new users are given: ticked to begin with. */
  defaults: string[];
  /** Sign-in methods whose word for an address is not trusted enough to claim
      an added person by it (src/lib/claim.ts), named for people to read. */
  cannotClaim?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState("");
  const [picked, setPicked] = useState<string[]>(defaults);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  const addresses = addressesIn(emails);
  // The roles new users are given first — they are the ones already ticked —
  // and the admin role last, apart from the ones that only open datasets.
  const rank = (r: RoleRow) => (defaults.includes(r.name) ? 0 : r.name === ADMIN ? 2 : 1);
  const ordered = [...roles].sort((a, b) => rank(a) - rank(b));
  const toggle = (role: string, on: boolean) =>
    setPicked((p) => (on ? [...p, role] : p.filter((r) => r !== role)));

  function reset() {
    setEmails("");
    setPicked(defaults);
    setProblems([]);
    setNotes([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (addresses.length === 0) return;
    setBusy(true);
    setProblems([]);
    setNotes([]);
    const failed: string[] = [];
    const told: string[] = [];
    const left: string[] = [];
    // One at a time: each address is its own decision on the server, and a
    // refusal for one ("already an active user") says nothing about the next.
    for (const email of addresses) {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", email, roles: picked }),
      }).catch(() => null);
      const json = (await res?.json().catch(() => null)) as { kind?: string; error?: string } | null;
      if (!res?.ok) {
        failed.push(`${email}: ${json?.error ?? `failed (${res?.status ?? "no response"})`}`);
        left.push(email);
      } else if (json?.kind === "approved") {
        told.push(`${email} was already waiting for approval, and is now in with these roles.`);
      }
    }
    setBusy(false);
    router.refresh();
    if (failed.length === 0 && told.length === 0) {
      reset();
      setOpen(false);
      return;
    }
    // Keep only what did not go through, so pressing the button again does not
    // re-add the ones that did.
    setEmails(left.join(", "));
    setProblems(failed);
    setNotes(told);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={PRIMARY}>
          Add user
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription className="sr-only">
            Add someone by email address and choose the roles they start with.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className={`flex flex-col gap-1 ${MUTED}`}>
            Email address
            <input
              type="text"
              inputMode="email"
              autoComplete="off"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="colleague@example.com"
              disabled={busy}
              className="rounded border border-gray-400 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-950 dark:text-gray-100"
            />
            <span>They are let in the first time they sign in with this address. Separate several with commas.</span>
            {cannotClaim.length > 0 && (
              <span className="text-amber-800 dark:text-amber-300">
                Not with {cannotClaim.join(" or ")}: this instance accepts any account there, so an address it
                reports is not proof of who is signing in. Someone added here must use another sign-in method.
              </span>
            )}
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className={`mb-1.5 ${MUTED}`}>Roles</legend>
            {ordered.map((r) => {
              const on = picked.includes(r.name);
              return (
                <label
                  key={r.name}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 ${
                    on ? "border-gray-900 dark:border-gray-100" : "border-gray-200 dark:border-gray-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={busy}
                    onChange={(e) => toggle(r.name, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block break-all text-xs font-semibold">{r.name}</span>
                    <span className={`block ${MUTED}`}>
                      {describeRole(r.name, datasets)}
                      {defaults.includes(r.name) ? " Given to new users." : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="flex flex-col gap-1.5 rounded-md bg-gray-100 px-3 py-2.5 dark:bg-gray-900">
            <span className={MUTED}>What they will get</span>
            <AccessSummary access={resolveAccess(picked, datasets)} datasets={datasets} admin={picked.includes(ADMIN)} />
          </div>

          {notes.map((n) => (
            <p key={n} className="text-xs text-gray-700 dark:text-gray-300">
              {n}
            </p>
          ))}
          {problems.map((p) => (
            <p key={p} role="alert" className="text-xs font-medium text-red-800 dark:text-red-300">
              {p}
            </p>
          ))}

          <DialogFooter className="flex-row items-center justify-end gap-2">
            <DialogClose asChild>
              <button type="button" className={BTN} disabled={busy}>
                {notes.length > 0 && problems.length === 0 ? "Done" : "Cancel"}
              </button>
            </DialogClose>
            <button type="submit" className={PRIMARY} disabled={busy || addresses.length === 0}>
              {busy ? "Adding…" : addresses.length > 1 ? `Add ${addresses.length} users` : "Add user"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
