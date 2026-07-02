// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useState } from "react";

// Editor for one instance_settings text field. Posts { [field]: value } to
// /api/admin/settings; an empty value resets the field to its default.
export default function SettingEditor({
  field,
  label,
  description,
  initialValue,
  defaultValue,
}: {
  field: string;
  label: string;
  description: string;
  initialValue: string;
  defaultValue: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(initialValue);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = value !== saved;

  async function save(next: string) {
    setStatus("saving");
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: next }),
    });
    if (!res.ok) { setStatus("error"); return; }
    const json = await res.json();
    const updated: string = json.settings?.[field] ?? "";
    setValue(updated);
    setSaved(updated);
    setStatus("saved");
  }

  return (
    <div className="space-y-2">
      <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{description}</p>
      <textarea
        value={value}
        onChange={(e) => { setValue(e.target.value); setStatus("idle"); }}
        rows={4}
        className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-600"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => save(value)}
          disabled={!dirty || status === "saving"}
          className="rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-xs disabled:opacity-40"
        >
          {status === "saving" ? "saving…" : "Save"}
        </button>
        <button
          onClick={() => save("")}
          disabled={status === "saving" || saved === defaultValue}
          className="rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40"
        >
          Reset to default
        </button>
        {status === "saved" && !dirty && <span className="text-xs text-green-600 dark:text-green-400">saved</span>}
        {status === "error" && <span className="text-xs text-red-600 dark:text-red-400">save failed</span>}
      </div>
    </div>
  );
}
