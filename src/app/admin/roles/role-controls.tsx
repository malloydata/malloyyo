// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** One POST to /api/admin/roles, then a refresh so the page shows what is
    stored. Shared by the Roles, Users and Datasets pages: roles, a person's
    roles and a dataset's scoping are all written through that one route. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(out?.error ?? `failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

export const BTN =
  "px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50";
export const INPUT =
  "px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-sm";

export function NewRoleForm({ onDone }: { onDone?: () => void }) {
  const { run, busy, error } = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run({ action: "create", name, description })) {
          setName("");
          setDescription("");
          onDone?.();
        }
      }}
    >
      <input
        className={INPUT}
        autoFocus={!!onDone}
        placeholder="finance"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Role name"
      />
      <input
        className={`${INPUT} flex-1 min-w-48`}
        placeholder="Who should hold this? e.g. the finance team"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Description"
      />
      <button type="submit" className={BTN} disabled={busy || !name.trim()}>
        Add role
      </button>
      {onDone && (
        <button type="button" className={BTN} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}

export function DeleteRoleButton({ name, holders }: { name: string; holders: number }) {
  const { run, busy, error } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={BTN}
        disabled={busy}
        onClick={() => {
          // Deleting revokes it everywhere, which is a bigger deal than the
          // button looks — say what it will take away before it does.
          const held = holders > 0 ? `${holders} person(s) hold it. ` : "";
          if (confirm(`Delete the role "${name}"? ${held}It will be removed from everyone who holds it and every dataset it opens.`)) {
            void run({ action: "delete", name });
          }
        }}
      >
        Delete
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

/** What a dataset is scoped by. Configured, not inferred from the model — the
    model must then declare what is ticked here or its next publish is refused. */
export function DatasetGivens({
  datasetId,
  all,
  required,
}: {
  datasetId: string;
  all: { name: string; description: string | null }[];
  required: string[];
}) {
  const { run, busy, error } = useAction();
  const [picked, setPicked] = useState<string[]>(required);
  const dirty = picked.length !== required.length || picked.some((g) => !required.includes(g));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-1">
        {all.map((g) => (
          <label key={g.name} className="inline-flex items-center gap-1.5 text-xs" title={g.description ?? undefined}>
            <input
              type="checkbox"
              checked={picked.includes(g.name)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, g.name] : p.filter((x) => x !== g.name)))
              }
            />
            <span className="font-mono">{g.name}</span>
          </label>
        ))}
      </div>
      {dirty && (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => void run({ action: "set-dataset-givens", datasetId, givens: picked })}
          >
            Save
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setPicked(required)}>
            Cancel
          </button>
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
