"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ColumnInfo = { name: string; type: string; nullable: boolean };
type TableInfo = { name: string; columns: ColumnInfo[] };

export default function TableModelPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tables")
      .then((r) => r.json())
      .then((data) => { setTables(data); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/datasets/new" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← add dataset
        </Link>
        <h1 className="text-xl font-bold mt-3">Build model from existing table</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          Select a table from MotherDuck and Claude will write a Malloy semantic model for it.
        </p>
      </header>

      {loading && <p className="text-xs text-gray-500 dark:text-gray-400">Loading tables…</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {!loading && !error && tables.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">No tables found in MotherDuck.</p>
      )}

      {!loading && !error && tables.length > 0 && (
        <div className="divide-y divide-gray-200 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded">
          {tables.map((table) => (
            <TableRow key={table.name} table={table} onCreated={(id) => router.push(`/datasets/${id}`)} />
          ))}
        </div>
      )}
    </main>
  );
}

function TableRow({ table, onCreated }: { table: TableInfo; onCreated: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(table.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mdTable: table.name, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `${res.status}`);
      onCreated(json.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setExpanded((x) => !x)}
          className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 w-4 text-center leading-none select-none"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <span className="font-semibold flex-1">{table.name}</span>
        <span className="text-xs text-gray-400">{table.columns.length} col{table.columns.length !== 1 ? "s" : ""}</span>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setName(table.name); setError(null); }}
            className="text-xs px-3 py-1 rounded bg-black text-white dark:bg-white dark:text-black"
          >
            Add Malloy Model
          </button>
        )}
      </div>

      {expanded && (
        <div className="ml-7 border border-gray-100 dark:border-gray-800 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400">
                <th className="px-3 py-1.5 font-medium">column</th>
                <th className="px-3 py-1.5 font-medium">type</th>
                <th className="px-3 py-1.5 font-medium">nullable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {table.columns.map((col) => (
                <tr key={col.name}>
                  <td className="px-3 py-1.5">{col.name}</td>
                  <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">{col.type}</td>
                  <td className="px-3 py-1.5 text-gray-400">{col.nullable ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="ml-7 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Dataset name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <button
              onClick={handleCreate}
              disabled={submitting || !name.trim()}
              className="text-xs px-3 py-1 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create model"}
            </button>
            <button
              onClick={() => { setAdding(false); setError(null); }}
              disabled={submitting}
              className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              cancel
            </button>
          </div>
          {submitting && <p className="text-xs text-gray-500 dark:text-gray-400">Starting — Claude will write the model in the background…</p>}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
