// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function AddRepoPage() {
  const router = useRouter();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
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
        body: JSON.stringify({ githubRepo: repo, githubBranch: branch, useToken: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `${res.status} ${res.statusText}`);
      }
      // `json.id` is only present when the repo published exactly ONE dataset;
      // a multi-dataset repo has no single id and this used to navigate to
      // /datasets/undefined. Both shapes carry the repo, which is the thing that
      // was just added and the page that shows everything it brought.
      router.push(`/repos/${encodeURIComponent(json.repo)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← all datasets
        </Link>
        <h1 className="text-xl font-bold mt-3">Add a repository</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          A repo publishes one dataset per directory under{" "}
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">datasets/</code>, or a single
          one from an <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">index.malloy</code>{" "}
          at its root. The directories name the datasets, so there is nothing to name here.
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


        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 disabled:opacity-50"
        >
          {submitting ? "Adding…" : "Add repository"}
        </button>

        {submitting && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Pulling the repo and compiling every dataset in it — may take a few seconds…
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
