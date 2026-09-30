// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

function useAction() {
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

const BTN =
  "px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50";
const INPUT =
  "px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-sm";

export function NewRoleForm() {
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
        }
      }}
    >
      <input
        className={INPUT}
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

/** Which datasets a role opens. Saved as a whole set, so unchecking is a real
    edit rather than something you have to remember to apply separately. */
export function RoleDatasets({
  name,
  all,
  granted,
}: {
  name: string;
  all: { id: string; name: string }[];
  granted: string[];
}) {
  const { run, busy, error } = useAction();
  const [picked, setPicked] = useState<string[]>(granted);
  const dirty =
    picked.length !== granted.length || picked.some((id) => !granted.includes(id));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {all.length === 0 && <span className="text-xs text-gray-400">no datasets yet</span>}
        {all.map((d) => (
          <label key={d.id} className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={picked.includes(d.id)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))
              }
            />
            {d.name}
          </label>
        ))}
      </div>
      {dirty && (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => void run({ action: "set-datasets", name, datasetIds: picked })}
          >
            Save
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setPicked(granted)}>
            Cancel
          </button>
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}

/** The roles one person holds. */
export function UserRoles({
  userId,
  all,
  held,
}: {
  userId: string;
  all: string[];
  held: string[];
}) {
  const { run, busy, error } = useAction();
  const [picked, setPicked] = useState<string[]>(held);
  const dirty = picked.length !== held.length || picked.some((r) => !held.includes(r));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {all.map((r) => (
          <label key={r} className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={picked.includes(r)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, r] : p.filter((x) => x !== r)))
              }
            />
            <span className={r.startsWith("MALLOYYO_") ? "text-gray-500 dark:text-gray-400" : ""}>{r}</span>
          </label>
        ))}
      </div>
      {dirty && (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => void run({ action: "set-user-roles", userId, roles: picked })}
          >
            Save
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setPicked(held)}>
            Cancel
          </button>
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}

/** What a newly admitted person is given. */
export function DefaultRoles({ all, current }: { all: string[]; current: string[] }) {
  const { run, busy, error } = useAction();
  const [picked, setPicked] = useState<string[]>(current);
  const dirty = picked.length !== current.length || picked.some((r) => !current.includes(r));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {all.map((r) => (
          <label key={r} className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={picked.includes(r)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, r] : p.filter((x) => x !== r)))
              }
            />
            {r}
          </label>
        ))}
      </div>
      {dirty && (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => void run({ action: "set-default", roles: picked })}
          >
            Save
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => setPicked(current)}>
            Cancel
          </button>
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
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
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {all.map((g) => (
          <label key={g.name} className="inline-flex items-center gap-1 text-xs" title={g.description ?? undefined}>
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
