// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The interactive half of the Users tab: buttons and one form, posting to the
// admin APIs and refreshing the server-rendered page. The two actions that
// take someone's access away — Disable and Deny — confirm first through the
// house dialog (src/components/ui/dialog.tsx); everything else is reversible
// from this same page and stays a plain button.

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
  if (role === "owner") return <span className="text-gray-400">owner</span>;

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
      {status !== "pending" && role === "member" && (
        <button className={BUTTON} disabled={busy} onClick={() => act("promote")}>Make admin</button>
      )}
      {status !== "pending" && role === "admin" && !isSelf && (
        <button className={BUTTON} disabled={busy} onClick={() => act("demote")}>Remove admin</button>
      )}
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

export function InviteForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const json = (await res.json().catch(() => null)) as { kind?: string; error?: string } | null;
    if (res.ok) {
      setEmail("");
      if (json?.kind === "approved") setNotice("They were already waiting — approved.");
      router.refresh();
    } else {
      setNotice(json?.error ?? `failed (${res.status})`);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="colleague@example.com"
        className="w-64 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-600"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
        className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-xs"
      >
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
      <button type="submit" disabled={busy || !email} className={PRIMARY_BUTTON}>
        Invite
      </button>
      {notice && <span className="text-xs text-gray-500 dark:text-gray-400">{notice}</span>}
    </form>
  );
}

export function RevokeInviteButton({ id }: { id: string }) {
  const { run, busy, error } = useAction();
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className={BUTTON}
        disabled={busy}
        onClick={() => void run(`/api/admin/invitations?id=${encodeURIComponent(id)}`, { method: "DELETE" })}
      >
        Revoke
      </button>
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

export function PolicyPicker({ current }: { current: "open" | "invite" }) {
  const { run, busy, error } = useAction();
  const set = (policy: string) =>
    void run("/api/admin/access-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    });

  const choice = (value: "invite" | "open", label: string, detail: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="radio"
        name="access-policy"
        checked={current === value}
        disabled={busy}
        onChange={() => set(value)}
        className="mt-0.5"
      />
      <span>
        <span className="text-gray-900 dark:text-gray-100">{label}</span>
        <span className="block text-gray-500 dark:text-gray-400">{detail}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-2 text-xs">
      {choice("invite", "Invite only", "Newcomers wait for approval below; invited addresses get in immediately.")}
      {choice("open", "Open", "Anyone who can sign in becomes a member — with a public provider, that is anyone at all.")}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
