// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The membership controls on Admin → Users: approve and deny the queue,
// disable and enable a person, take back an address that was added, and the
// admission policy. Buttons posting to the admin APIs and refreshing the
// server-rendered page. The two actions that take someone's access away —
// Disable and Deny — confirm first through the house dialog
// (src/components/ui/dialog.tsx); everything else is reversible from the same
// page and stays a plain button. Adding someone is ./add-user.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(input: RequestInfo, init?: RequestInit) {
    setBusy(true);
    setError(null);
    const res = await fetch(input, init);
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(json?.error ?? `failed (${res.status})`);
      setBusy(false);
      return false;
    }
    router.refresh();
    setBusy(false);
    return true;
  }
  return { run, busy, error };
}

const BUTTON =
  "rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40";
const PRIMARY_BUTTON =
  "rounded bg-black text-white dark:bg-white dark:text-black px-2 py-1 text-xs hover:opacity-90 disabled:opacity-40";

export function UserActions({
  userId,
  status,
  role,
  isSelf,
  label,
}: {
  userId: string;
  status: "pending" | "active" | "disabled";
  role: "owner" | "admin" | "member";
  isSelf: boolean;
  /** How the dialogs name this person — their name or address. */
  label: string;
}) {
  const { run, busy, error } = useAction();
  const post = (action: string) =>
    run("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, action }),
    });
  const act = (action: string) => void post(action);

  // The server refuses these too; hiding them just keeps the row honest.
  if (role === "owner") return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {status === "pending" && (
        <>
          <button className={PRIMARY_BUTTON} disabled={busy} onClick={() => act("approve")}>Approve</button>
          <ConfirmDialog
            trigger={<button className={BUTTON} disabled={busy}>Deny</button>}
            title={`Deny ${label}?`}
            description="They stay signed out of everything and leave the queue. You can enable them later from the members list."
            confirmLabel="Deny"
            destructive
            onConfirm={() => post("deny")}
          />
        </>
      )}
      {status === "active" && !isSelf && (
        <ConfirmDialog
          trigger={<button className={BUTTON} disabled={busy}>Disable</button>}
          title={`Disable ${label}?`}
          description="Their access ends with their very next request — including any signed-in browser tab and every connected MCP client. You can enable them again here."
          confirmLabel="Disable"
          destructive
          onConfirm={() => post("disable")}
        />
      )}
      {status === "disabled" && (
        <button className={BUTTON} disabled={busy} onClick={() => act("enable")}>Enable</button>
      )}
      {/* No "Make admin" / "Remove admin" here any more. Being an admin is
          holding MALLOYYO_ADMIN, which is ticked like any other role in the
          same row's "Edit roles" — two controls for one fact was one too many. */}
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

/** Take back an address that was added and has not signed in yet. Nothing to
    confirm: they have nothing here to lose, and adding them again is one form. */
export function RevokeInviteButton({ id }: { id: string }) {
  const { run, busy, error } = useAction();
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className={BUTTON}
        disabled={busy}
        onClick={() => void run(`/api/admin/invitations?id=${encodeURIComponent(id)}`, { method: "DELETE" })}
      >
        Remove
      </button>
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

export function PolicyPicker({ current }: { current: "open" | "invite" }) {
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState(false);
  // Shown at once and put back if the server refuses: a radio button that
  // waits for the round trip before it moves reads as a click that missed.
  const [shown, setShown] = useState(current);
  const set = async (policy: "invite" | "open") => {
    setShown(policy);
    const ok = await run("/api/admin/access-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    });
    if (!ok) setShown(current);
  };

  const choice = (value: "invite" | "open", label: string, detail: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="radio"
        name="access-policy"
        checked={shown === value}
        disabled={busy}
        onChange={() => void set(value)}
        className="mt-0.5"
      />
      <span>
        <span className="text-gray-900 dark:text-gray-100">{label}</span>
        <span className="block text-gray-500 dark:text-gray-400">{detail}</span>
      </span>
    </label>
  );

  // One line and a button until someone wants to change it: this is set once
  // per instance, and a pair of radio buttons sitting open under the list of
  // people is an invitation to change it by accident.
  return (
    <div className="flex flex-col gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 text-xs text-gray-600 dark:text-gray-400">
          <span className="text-gray-900 dark:text-gray-100">
            Who may join: {shown === "invite" ? "invite only" : "open"}.
          </span>{" "}
          {shown === "invite"
            ? "Anyone you have not added waits for your approval."
            : "Anyone who can sign in becomes a member."}
        </span>
        <button type="button" className={`shrink-0 ${BUTTON}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open && (
        <div className="space-y-2 text-xs">
          {choice("invite", "Invite only", "Only people you add get in. Anyone else who signs in waits for your approval at the top of this page.")}
          {choice("open", "Open", "Anyone who can sign in becomes a member — with a public provider, that is anyone at all.")}
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
