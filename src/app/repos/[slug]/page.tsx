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
import { useRouter } from "next/navigation";
import Link from "next/link";

type RepoDetail = {
  id: string;
  slug: string;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUseToken: boolean;
  live: { revision: number; verifiedAt: string | null; gitSha: string | null } | null;
  needsUpdate: boolean;
  /** What removing this repo would take with it, counted server-side so the
      warning names real numbers instead of "and related data". */
  removalImpact: {
    datasets: number;
    revisions: number;
    savedQueries: number;
    drafts: number;
    /** Chats reference a dataset by NAME with no foreign key, so these are not
        deleted — they are left pointing at a name nothing resolves. */
    orphanedChats: number;
  };
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
    statusError: string | null;
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
      <RemoveSection repo={data} />
    </main>
  );
}

function GitHubSection({ repo, onChanged }: { repo: RepoDetail; onChanged: () => void }) {
  const [ghRepo, setGhRepo] = useState(repo.githubRepo ?? "");
  const [branch, setBranch] = useState(repo.githubBranch ?? "main");
  const [useToken, setUseToken] = useState(repo.githubUseToken);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [unclaimed, setUnclaimed] = useState<string[]>([]);

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

  async function refresh(create = false) {
    setBusy(create ? "create" : "refresh");
    setMsg(null);
    const res = await fetch(
      `/api/repos/${encodeURIComponent(repo.slug)}/refresh${create ? "?create=1" : ""}`,
      { method: "POST" },
    );
    const j = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setMsg({ kind: "err", text: j.error ?? `HTTP ${res.status}` });

    const n = (j.datasets ?? []).length;
    const unclaimed: string[] = j.unclaimed ?? [];
    setMsg({
      kind: "ok",
      text: j.unchanged
        ? `already at revision ${j.revision} — nothing on GitHub has changed`
        : `revision ${j.revision} is live (${n} dataset${n === 1 ? "" : "s"})` +
          // Saying this is the difference between "it worked" and knowing why a
          // repo that pulled fine still serves nothing.
          (unclaimed.length > 0
            ? ` — ${unclaimed.length} director${unclaimed.length === 1 ? "y" : "ies"} no dataset covers: ${unclaimed.join(", ")}`
            : ""),
    });
    setUnclaimed(unclaimed);
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
          onClick={() => refresh(false)}
          disabled={!repo.githubRepo || busy !== null}
          title={repo.githubRepo ? "Pull this repo from GitHub again" : "Attach a GitHub repo first"}
          className="text-xs px-2.5 py-1 rounded border border-gray-900 dark:border-gray-200 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 disabled:opacity-40"
        >
          {busy === "refresh" ? "refreshing…" : "Refresh from GitHub"}
        </button>
        {/* Only once there is something to create. Creating datasets is not what
            "refresh" means, so it is a separate, deliberate act — but a repo with
            no datasets is inert without it: a plain refresh succeeds, publishes
            nothing, and reports every directory unclaimed. */}
        {(unclaimed.length > 0 || repo.datasets.length === 0) && repo.githubRepo && (
          <button
            onClick={() => refresh(true)}
            disabled={busy !== null}
            title="Pull again, and create a dataset for each directory no dataset covers"
            className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            {busy === "create" ? "creating…" : "Refresh and create missing datasets"}
          </button>
        )}
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
              {/* The reason is recorded on the row; showing the word without it
                  left "failed" as something you could only explain with SQL.
                  The pair in this repo failed on a BigQuery credential in
                  August and have sat there since. */}
              {d.status !== "ready" && (
                <span
                  title={d.statusError ?? `status: ${d.status}`}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    d.status === "failed"
                      ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800/60 cursor-help"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500"
                  }`}
                >
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

/**
 * Removing the repository from the server.
 *
 * Last on the page, and the only thing here that cannot be undone — the stored
 * revisions ARE the copies of the repo, so there is nothing left to roll back
 * to afterwards. Two things follow from that:
 *
 *  - It states what goes, with counts from the server. "Remove this repository"
 *    reads like unlinking a GitHub coordinate, and it actually deletes datasets
 *    and other people's saved queries. A warning that says "and related data"
 *    is one the reader has to guess at.
 *  - The button stays disabled until the slug is typed. Not theatre: this
 *    instance holds `malloyyo_babyname` and `malloyyo_babynames`, and a repo
 *    page is reached from a list of near-identical names.
 */
function RemoveSection({ repo }: { repo: RepoDetail }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const impact = repo.removalImpact;

  const goes = [
    [impact.datasets, "dataset"],
    [impact.revisions, "stored revision"],
    [impact.savedQueries, "saved query"],
    [impact.drafts, "draft dashboard"],
  ] as const;
  const listed = goes.filter(([n]) => n > 0).map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/repos/${encodeURIComponent(repo.slug)}?confirm=${encodeURIComponent(repo.slug)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      // Home, because this page's subject no longer exists — staying here would
      // re-fetch it and render its own 404.
      router.push("/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/20 p-4">
      <h2 className="text-sm font-medium text-red-800 dark:text-red-300">Remove from this server</h2>

      <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
        Deletes <code className="text-[11px]">{repo.slug}</code> and everything it publishes
        {listed.length > 0 ? <>: {listed.join(", ")}</> : null}. This cannot be undone — the stored
        revisions are the only copies on this server, so there is nothing to roll back to. The repo
        on GitHub is untouched, and publishing it again would start from revision 1.
      </p>

      {impact.orphanedChats > 0 && (
        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
          {impact.orphanedChats} chat{impact.orphanedChats === 1 ? "" : "s"} asked questions of{" "}
          {impact.datasets === 1 ? "this dataset" : "these datasets"} and will be kept — they are
          people&apos;s own question history, so removing a repo does not delete them. They will
          refer to a dataset that no longer exists.
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-600 dark:text-gray-400">
          Type <code className="text-[11px]">{repo.slug}</code> to confirm
        </span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={repo.slug}
          autoComplete="off"
          spellCheck={false}
          className="w-full max-w-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 font-mono text-xs"
        />
      </label>

      <div>
        <button
          onClick={remove}
          disabled={busy || typed !== repo.slug}
          className="rounded bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-red-600"
        >
          {busy ? "removing…" : "Remove this repository"}
        </button>
      </div>

      {err && (
        <pre className="whitespace-pre-wrap text-xs text-red-700 dark:text-red-400">{err}</pre>
      )}
    </section>
  );
}
