// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The interactive half of the tokens page: the create form (which is also the
// only place the secret is ever shown) and the revoke button.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  API_TOKEN_SCOPES,
  SCOPE_DESCRIPTIONS,
  type ApiTokenScope,
} from "@/lib/api-token-scopes";

const BUTTON =
  "rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40";
const PRIMARY_BUTTON =
  "rounded bg-black text-white dark:bg-white dark:text-black px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-40";
const FIELD =
  "rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1 text-xs";

/** Expiry choices. `null` is never — see src/lib/api-tokens.ts. */
const EXPIRY_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
];

export function CreateTokenForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>(["publish"]);
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);

  function toggle(scope: ApiTokenScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // try/finally, not a bare await: a dropped connection would otherwise
    // leave the button disabled on "Creating…" with nothing said.
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scopes,
          expiresInDays: expiry === "never" ? null : Number(expiry),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { value?: string; error?: string }
        | null;
      if (!res.ok || !json?.value) {
        setError(json?.error ?? `failed (${res.status})`);
        return;
      }
      setMinted(json.value);
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  if (minted) {
    return (
      <MintedToken
        value={minted}
        onDone={() => {
          setMinted(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 border border-gray-200 dark:border-gray-800 rounded p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        New token
      </h2>

      <label className="block space-y-1">
        <span className="text-xs text-gray-600 dark:text-gray-400">
          Name — what this token is for
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="github actions"
          maxLength={64}
          required
          className={`${FIELD} w-full max-w-sm block`}
        />
      </label>

      <fieldset className="space-y-1">
        <legend className="text-xs text-gray-600 dark:text-gray-400">Scopes</legend>
        {API_TOKEN_SCOPES.map((scope) => (
          <label key={scope} className="flex items-baseline gap-2 text-xs">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={() => toggle(scope)}
            />
            <span>
              <code>{scope}</code>{" "}
              <span className="text-gray-500 dark:text-gray-400">— {SCOPE_DESCRIPTIONS[scope]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="text-xs text-gray-600 dark:text-gray-400">Expires</span>
        <select
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className={`${FIELD} block`}
        >
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.label} value={c.days === null ? "never" : String(c.days)}>
              {c.label}
            </option>
          ))}
        </select>
        {expiry === "never" && (
          <span className="block text-[11px] text-gray-500 dark:text-gray-400">
            A token that never expires keeps working until you revoke it here.
          </span>
        )}
      </label>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <button className={PRIMARY_BUTTON} disabled={busy || !name.trim() || scopes.length === 0}>
        {busy ? "Creating…" : "Create token"}
      </button>
    </form>
  );
}

/**
 * The one and only time the secret is on screen. Nothing stores it — not this
 * page, not the server — so the copy button and the warning are the whole
 * affordance.
 */
function MintedToken({ value, onDone }: { value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-3 border border-green-300 dark:border-green-800 rounded p-4">
      <h2 className="text-xs uppercase tracking-wide text-green-700 dark:text-green-400">
        Token created
      </h2>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Copy it now — this is the only time it is shown. If you lose it, revoke it and
        create another.
      </p>
      <pre className="rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-3 py-2 text-xs overflow-x-auto select-all">
        export MALLOYYO_TOKEN={value}
      </pre>
      <div className="flex gap-2">
        <button
          className={BUTTON}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy token"}
        </button>
        <button className={BUTTON} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

export function RevokeTokenButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The dialog stays open when onConfirm resolves false, so a failure has to
  // say something there — and it must RESOLVE rather than throw, or the dialog
  // is left busy with Cancel and Esc disabled.
  async function revoke(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? `could not revoke (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not reach the server");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <ConfirmDialog
        trigger={
          <button className={BUTTON} disabled={busy}>
            Revoke
          </button>
        }
        title={`Revoke "${name}"?`}
        description={
          <>
            Anything using this token stops working on its very next request — a CI job
            included. This cannot be undone; create a new token instead.
            {error && (
              <span className="block mt-2 text-red-600 dark:text-red-400">{error}</span>
            )}
          </>
        }
        confirmLabel="Revoke"
        destructive
        onConfirm={revoke}
      />
      {error && <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
