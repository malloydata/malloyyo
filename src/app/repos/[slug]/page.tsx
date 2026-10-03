// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `/repos/<slug>` — where a repo is configured.
 *
 * This is the page that did not exist. Everything on it was previously on a
 * DATASET's config page, which meant a repo with four datasets offered four
 * copies of one set of settings, each editable on its own: four GitHub fields
 * for one GitHub repo, four webhook URLs for the one webhook a repo has, and a
 * Refresh button that always refreshed the whole repo under a heading that said
 * it was about one dataset.
 *
 * Client component because every control here writes and then needs to show
 * what happened — the dataset config page it inherits from works the same way.
 */

"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

type RepoDetail = {
  id: string;
  slug: string;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUseToken: boolean;
  live: { revision: number; verifiedAt: string | null; gitSha: string | null } | null;
  needsUpdate: boolean;
  history: Array<{
    id: string;
    revision: number;
    source: string;
    active: boolean;
    verifiedAt: string | null;
    verifyError: string | null;
    gitSha: string | null;
    archiveBytes: number;
    createdAt: string;
  }>;
  datasets: Array<{
    id: string;
    name: string;
    qualified: string;
    displayTitle: string;
    status: string;
    repoDir: string;
    entryFile: string;
    createdAt: string;
    legacyModels: number;
  }>;
};

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}KB`;

export default function RepoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [data, setData] = useState<RepoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Declared inside the effect, with a cancel flag, the way the dataset config
  // page does it: setState reached directly from an effect body is what
  // react-hooks/set-state-in-effect refuses, and an await that resolves after
  // the component is gone is what the flag is for.
  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function fetchRepo() {
      const res = await fetch(`/api/repos/${encodeURIComponent(slug)}`);
      const json = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(json);
      setError(null);
    }
    void fetchRepo();
    return () => {
      cancelled = true;
    };
  }, [slug, reloads]);

  if (error) return <main className="p-6 text-sm text-red-600 dark:text-red-400">{error}</main>;
  if (!data) return <main className="p-6 text-xs text-gray-500">loading…</main>;

  return (
    <main className="max-w-3xl mx-auto p-6 flex flex-col gap-6">
      <div>
        <Link href="/" className="text-xs text-gray-500 hover:underline">
          ← all datasets
        </Link>
        <h1 className="text-xl font-semibold mt-2 flex items-center gap-2">
          {data.slug}
          {data.needsUpdate && (
            <span
              title="Still served from the old per-file storage. Refresh from GitHub to move it onto a verified revision."
              className="text-[10px] font-normal px-1.5 py-0.5 rounded border border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-700/60 dark:text-amber-300 dark:bg-amber-900/30"
            >
              needs update
            </span>
          )}
        </h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Datasets in this repo are addressed <code className="text-[11px]">{data.slug}:&lt;name&gt;</code>.
        </p>
      </div>

      <GitHubSection repo={data} onChanged={load} />
      <DatasetsSection repo={data} />
      <RevisionsSection repo={data} />
    </main>
  );
}

function GitHubSection({ repo, onChanged }: { repo: RepoDetail; onChanged: () => void }) {
  const [ghRepo, setGhRepo] = useState(repo.githubRepo ?? "");
  const [branch, setBranch] = useState(repo.githubBranch ?? "main");
  const [useToken, setUseToken] = useState(repo.githubUseToken);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const dirty =
    ghRepo !== (repo.githubRepo ?? "") ||
    branch !== (repo.githubBranch ?? "main") ||
    useToken !== repo.githubUseToken;

  async function save() {
    setBusy("save");
    setMsg(null);
    const res = await fetch(`/api/repos/${encodeURIComponent(repo.slug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubRepo: ghRepo || null, githubBranch: branch || null, githubUseToken: useToken }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setMsg({ kind: "err", text: j.error ?? `HTTP ${res.status}` });
    setMsg({ kind: "ok", text: "saved" });
    onChanged();
  }

  async function refresh() {
    setBusy("refresh");
    setMsg(null);
    const res = await fetch(`/api/repos/${encodeURIComponent(repo.slug)}/refresh`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setMsg({ kind: "err", text: j.error ?? `HTTP ${res.status}` });
    setMsg({
      kind: "ok",
      text: j.unchanged
        ? `already at revision ${j.revision} — nothing on GitHub has changed`
        : `revision ${j.revision} is live (${(j.datasets ?? []).length} dataset(s))`,
    });
    onChanged();
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">GitHub</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Where this repo is pulled from. It is the repo&rsquo;s, not any one dataset&rsquo;s, so
        changing it moves every dataset in it.
      </p>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-xs">
          <span className="block text-gray-500 dark:text-gray-400 mb-1">Repo</span>
          <input
            value={ghRepo}
            onChange={(e) => setGhRepo(e.target.value)}
            placeholder="owner/name"
            className="border border-gray-300 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-950 font-mono text-xs w-64"
          />
        </label>
        <label className="text-xs">
          <span className="block text-gray-500 dark:text-gray-400 mb-1">Branch</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="border border-gray-300 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-950 font-mono text-xs w-32"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs pb-1.5">
          <input type="checkbox" checked={useToken} onChange={(e) => setUseToken(e.target.checked)} />
          {/* There was no control for this before, and the form it lived on sent
              `true` on every save — which is how one repo ended up with rows
              disagreeing about it. */}
          <span title="Send GITHUB_TOKEN when pulling. Required for a private repo.">use token</span>
        </label>
        <button
          onClick={save}
          disabled={!dirty || busy !== null}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-900"
        >
          {busy === "save" ? "saving…" : "Save"}
        </button>
        <button
          onClick={refresh}
          disabled={!repo.githubRepo || busy !== null}
          title={repo.githubRepo ? "Pull this repo from GitHub again" : "Attach a GitHub repo first"}
          className="text-xs px-2.5 py-1 rounded border border-gray-900 dark:border-gray-200 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 disabled:opacity-40"
        >
          {busy === "refresh" ? "refreshing…" : "Refresh from GitHub"}
        </button>
      </div>

      {msg && (
        <p className={`text-xs ${msg.kind === "ok" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {msg.text}
        </p>
      )}

      {repo.githubRepo && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <span className="block mb-1">
            Webhook payload URL — a repo has one, and a push to it refreshes the whole repo:
          </span>
          <code className="block text-[11px] bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-2 py-1 break-all">
            {origin}/api/repos/{repo.id}/webhook/github
          </code>
        </div>
      )}
    </section>
  );
}

function DatasetsSection({ repo }: { repo: RepoDetail }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Datasets ({repo.datasets.length})</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        One per directory in the repo. Who may open them is set in{" "}
        <Link href="/admin/roles" className="underline">
          roles
        </Link>
        .
      </p>
      <div className="border border-gray-200 dark:border-gray-800 rounded divide-y divide-gray-200 dark:divide-gray-800">
        {repo.datasets.length === 0 && (
          <p className="text-xs text-gray-500 p-3">
            None yet. A publish creates them from the directories under{" "}
            <code className="text-[11px]">datasets/</code>.
          </p>
        )}
        {repo.datasets.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">
              <Link href={`/datasets/${encodeURIComponent(d.name)}`} className="text-sm font-medium hover:underline">
                {d.displayTitle}
              </Link>
              <span className="block text-[11px] text-gray-500 dark:text-gray-400 font-mono truncate">
                {d.qualified}
                {/* The entry file, not the directory: a dataset at the repo
                    root has no directory, and naming the file says what is
                    actually there. Dated too, because the name index is partial
                    on `ready` — so a repo really can hold two failed rows that
                    are otherwise identical, and some do. Time and not just date:
                    the pair this was written against was created fifteen minutes
                    apart, so a date alone still showed two of the same thing. */}
                {` · ${d.entryFile} · ${new Date(d.createdAt).toLocaleString()}`}
              </span>
            </span>
            <span className="flex items-center gap-2 flex-shrink-0">
              {d.legacyModels > 0 && (
                <span
                  title="This dataset still has model versions stored the old way. They are retired when the repo is next refreshed."
                  className="text-[10px] px-1.5 py-0.5 rounded border border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-700/60 dark:text-amber-300 dark:bg-amber-900/30"
                >
                  {d.legacyModels} old version{d.legacyModels === 1 ? "" : "s"}
                </span>
              )}
              {d.status !== "ready" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
                  {d.status}
                </span>
              )}
              {/* No "config" link: a repo-backed dataset's config page now
                  redirects straight back here, so it would be a loop. */}
              <Link
                href={`/datasets/${encodeURIComponent(d.name)}`}
                className="text-[11px] text-gray-500 hover:underline"
              >
                open
              </Link>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RevisionsSection({ repo }: { repo: RepoDetail }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Revisions</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Every publish and every webhook push, whether it went live or not. The contents of each
        are kept, so what this instance was serving at any point is recorded.
      </p>
      {repo.history.length === 0 ? (
        <p className="text-xs text-gray-500 border border-gray-200 dark:border-gray-800 rounded p-3">
          None. This repo has not been published or refreshed since it was created — which for an
          instance that upgraded means it is still served from the old per-file storage.
        </p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded divide-y divide-gray-200 dark:divide-gray-800 text-xs">
          {repo.history.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-1.5">
              <span className="font-mono w-10 text-gray-500">#{r.revision}</span>
              <span className="w-16 text-gray-500">{r.source}</span>
              <span className="font-mono text-gray-500 w-16">{short(r.gitSha) ?? "—"}</span>
              <span className="text-gray-400 w-14">{kb(r.archiveBytes)}</span>
              <span className="flex-1 truncate">
                {r.active ? (
                  <span className="text-green-700 dark:text-green-400">live</span>
                ) : r.verifyError ? (
                  <span className="text-red-600 dark:text-red-400" title={r.verifyError}>
                    failed: {r.verifyError}
                  </span>
                ) : r.verifiedAt ? (
                  <span className="text-gray-400">superseded</span>
                ) : (
                  <span className="text-gray-400">not verified</span>
                )}
              </span>
              <span className="text-gray-400 whitespace-nowrap">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
