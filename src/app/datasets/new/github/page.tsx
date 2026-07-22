// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function GitHubModelPage() {
  const router = useRouter();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
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
        body: JSON.stringify({ githubRepo: repo, githubBranch: branch, githubPath: path, name, useToken: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `${res.status} ${res.statusText}`);
      }
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
        <h1 className="text-xl font-bold mt-3">Add Malloy model from GitHub</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          The repo must have an <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">index.malloy</code> at
          its root (or under the path below, if set). Import paths are resolved relative to that file
          within the same repo and branch.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        <label className="block">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Repository (owner/repo)
          </span>
          <input
            type="text"
            required
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            placeholder="lloydtabb/auto_recalls"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Branch</span>
          <input
            type="text"
            required
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            placeholder="main"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Path within repo (optional — directory containing index.malloy)
          </span>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            placeholder="malloy/"
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
            placeholder="auto_recalls"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 disabled:opacity-50"
        >
          {submitting ? "Loading model…" : "Load from GitHub"}
        </button>

        {submitting && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Fetching and compiling model — may take a few seconds…
          </p>
        )}

        {error && (
          <pre className="text-red-600 dark:text-red-400 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-3 rounded">
            {error}
          </pre>
        )}
      </form>
    </main>
  );
}
