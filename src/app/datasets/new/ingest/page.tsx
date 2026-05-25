"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const SAMPLE_URL =
  "https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet";

export default function IngestPage() {
  const router = useRouter();
  const [url, setUrl] = useState(SAMPLE_URL);
  const [name, setName] = useState("yellow_taxi");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl: url, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
      router.push(`/datasets/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/datasets/new" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← add dataset
        </Link>
        <h1 className="text-xl font-bold mt-3">Ingest from URL</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          We load the file into MotherDuck, read the schema, then ask Claude to write a Malloy
          semantic model. Large files take longer.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        <label className="block">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Source URL (Parquet or CSV)
          </span>
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            placeholder="https://…/file.parquet"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Dataset name (snake_case — used in Malloy queries)
          </span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            placeholder="my_dataset"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Ingest"}
        </button>

        {error && (
          <pre className="text-red-600 dark:text-red-400 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-3 rounded">
            {error}
          </pre>
        )}
      </form>
    </main>
  );
}
