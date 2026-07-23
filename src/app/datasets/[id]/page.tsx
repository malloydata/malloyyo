// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";

type DatasetDetail = {
  id: string;
  name: string;
  status: string;
  statusError: string | null;
  createdAt: string;
  readyAt: string | null;
  userSlug: string | null;
  isPublic: boolean;
  isAdmin: boolean;
  githubRepo: string | null;
  githubBranch: string | null;
  dashboards: Array<{ name: string; title: string; manifest: Record<string, unknown>; source: string }>;
  lastPublish: {
    at: string;
    sha: string | null;
    branch: string | null;
    error: string | null;
  } | null;
  malloyModel: {
    id: string;
    source: string;
    generatedBy: string;
    compiledAt: string | null;
    sources: string[] | null;
    files: Array<{ path: string; content: string }> | null;
    git: GitProvenance | null;
  } | null;
};

type GitProvenance = {
  repo: string | null;
  branch: string | null;
  sha: string | null;
  dirty: boolean | null;
};

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

// branch@sha chip, linking to the commit when the repo is on GitHub.
function CommitChip({ git }: { git: GitProvenance }) {
  if (!git.sha && !git.branch) return null;
  const label = `${git.branch ?? "?"}${git.sha ? `@${shortSha(git.sha)}` : ""}`;
  const url = git.repo && git.sha ? `https://github.com/${git.repo}/commit/${git.sha}` : null;
  return (
    <span className="inline-flex items-center gap-1.5 font-normal">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-600 dark:text-blue-400 hover:underline">
          {label}
        </a>
      ) : (
        <span className="font-mono text-gray-500 dark:text-gray-400">{label}</span>
      )}
      {git.dirty && (
        <span title="published with uncommitted changes" className="text-amber-600 dark:text-amber-400 text-[10px]">
          ● dirty
        </span>
      )}
    </span>
  );
}

// Surfaces the last CLI publish attempt. Failures are loud (the live model below is
// unchanged); successes are a quiet one-liner.
function LastPublishBanner({ lastPublish }: { lastPublish: NonNullable<DatasetDetail["lastPublish"]> }) {
  const ref = `${lastPublish.branch ?? "?"}${lastPublish.sha ? `@${shortSha(lastPublish.sha)}` : ""}`;
  const when = new Date(lastPublish.at).toLocaleString();
  if (lastPublish.error) {
    return (
      <section>
        <h2 className="text-sm font-semibold mb-1 text-red-700 dark:text-red-300">last publish failed</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          <span className="font-mono">{ref}</span> · {when} — the live model below is unchanged.
        </p>
        <pre className="text-red-700 dark:text-red-300 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-3 rounded">
          {lastPublish.error}
        </pre>
      </section>
    );
  }
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400">
      last published <span className="font-mono">{ref}</span> · {when}
    </p>
  );
}

const TERMINAL = new Set(["ready", "failed"]);

const STAGE_INFO: Record<string, { label: string; detail: string }> = {
  pending: { label: "Queued", detail: "About to load the model from GitHub." },
  modeling: { label: "Loading from GitHub", detail: "Fetching and compiling the Malloy model." },
  ready: { label: "Ready", detail: "Your dataset is live and queryable via the MCP server." },
  failed: { label: "Failed", detail: "See the error details below." },
};

export default function DatasetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<DatasetDetail | null>(null);
  // setData is passed to GitHubConfig so it can update malloyModel after refresh.

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const res = await fetch(`/api/datasets/${id}`);
      if (!res.ok) return;
      const json: DatasetDetail = await res.json();
      if (cancelled) return;
      setData(json);
      if (!TERMINAL.has(json.status)) setTimeout(poll, 1500);
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!data) return <main className="p-8 font-mono text-sm">loading…</main>;

  const stage = STAGE_INFO[data.status] ?? {
    label: data.status,
    detail: "",
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 font-mono text-sm space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← all datasets</Link>
          <h1 className="text-xl font-bold mt-2">{data.name}</h1>
        </div>
        {data.isAdmin && (
          <div className="flex items-center gap-2">
            <VisibilityToggle datasetId={data.id} initialIsPublic={data.isPublic} />
            <DeleteButton datasetId={data.id} datasetName={data.name} />
          </div>
        )}
      </header>

      {/* Top of the page: the repo this model comes from and the button that
          pulls it again. It's the control people come here to use, so it leads
          rather than sitting below the status/dashboards/model sections. */}
      {data.isAdmin && data.githubRepo && (
        <GitHubConfig
          datasetId={data.id}
          initialRepo={data.githubRepo}
          initialBranch={data.githubBranch}
          onRefreshed={(model) => setData((d) => d ? { ...d, malloyModel: model } : d)}
        />
      )}

      <section className="border border-gray-200 dark:border-gray-800 rounded p-4 space-y-2">
        <div className="flex items-center gap-3">
          <StatusBadge status={data.status} />
          <span className="font-semibold">{stage.label}</span>
        </div>
        {stage.detail && (
          <p className="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
            {stage.detail}
          </p>
        )}
      </section>

      <section className="grid grid-cols-[140px_1fr] gap-y-1 text-xs">
        <span className="text-gray-500 dark:text-gray-400">created</span>
        <span>{new Date(data.createdAt).toLocaleString()}</span>
        <span className="text-gray-500 dark:text-gray-400">ready</span>
        <span>{data.readyAt ? new Date(data.readyAt).toLocaleString() : "—"}</span>
      </section>

      <DashboardsSection datasetName={data.name} dashboards={data.dashboards} />

      {data.statusError && (
        <section>
          <h2 className="text-sm font-semibold mb-1">error</h2>
          <pre className="text-red-700 dark:text-red-300 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-3 rounded">
            {data.statusError}
          </pre>
        </section>
      )}

      {data.lastPublish && <LastPublishBanner lastPublish={data.lastPublish} />}

      {data.malloyModel && (
        data.malloyModel.files
          ? <GitHubModelView datasetId={data.id} model={data.malloyModel} />
          : <ModelReadOnly source={data.malloyModel.source} generatedBy={data.malloyModel.generatedBy} git={data.malloyModel.git} />
      )}
    </main>
  );
}

// The dataset's dashboards (from ./dashboards in the model repo): a link to open
// each, plus its manifest.json + Dashboard.tsx contents (expandable, like the
// model files). Hidden when the dataset has none.
function DashboardsSection({
  datasetName,
  dashboards,
}: {
  datasetName: string;
  dashboards: DatasetDetail["dashboards"];
}) {
  if (!dashboards || dashboards.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">dashboards ({dashboards.length})</h2>
      {dashboards.map((d) => (
        <div key={d.name} className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-800">
            <span className="font-semibold text-xs">{d.title}</span>
            <Link
              href={`/datasets/${encodeURIComponent(datasetName)}/dashboard/${encodeURIComponent(d.name)}`}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              open ↗
            </Link>
          </div>
          <DashboardFile path={`dashboards/${d.name}/manifest.json`} content={JSON.stringify(d.manifest, null, 2)} />
          <DashboardFile path={`dashboards/${d.name}/Dashboard.tsx`} content={d.source} defaultOpen={false} />
        </div>
      ))}
    </section>
  );
}

function DashboardFile({ path, content, defaultOpen = false }: { path: string; content: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-gray-100 dark:border-gray-900 first:border-t-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-mono text-left hover:bg-gray-50 dark:hover:bg-gray-900/50"
      >
        <span className="text-gray-600 dark:text-gray-400">{path}</span>
        <span className="text-gray-400 dark:text-gray-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <pre className="text-[11px] bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-t border-gray-200 dark:border-gray-800 p-3 overflow-auto whitespace-pre">
          {content}
        </pre>
      )}
    </div>
  );
}

type CompileResult = { ok: true; sql: string } | { ok: false; error: string };

function ModelReadOnly({ source, generatedBy, git }: { source: string; generatedBy: string; git: GitProvenance | null }) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1 flex items-baseline gap-2 flex-wrap">
        malloy model{" "}
        {git ? <CommitChip git={git} /> : <span className="text-gray-400 dark:text-gray-500 font-normal">(from {generatedBy})</span>}
      </h2>
      <pre className="text-[11px] bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-800 rounded p-3 overflow-auto whitespace-pre">
        {source}
      </pre>
    </section>
  );
}

function VisibilityToggle({ datasetId, initialIsPublic }: { datasetId: string; initialIsPublic: boolean }) {
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const res = await fetch(`/api/datasets/${datasetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPublic: !isPublic }),
    });
    if (res.ok) setIsPublic(!isPublic);
    setBusy(false);
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`text-xs px-3 py-1.5 rounded border disabled:opacity-50 whitespace-nowrap ${
        isPublic
          ? "border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20"
          : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900"
      }`}
    >
      {busy ? "saving…" : isPublic ? "public — make private" : "private — make public"}
    </button>
  );
}

function DeleteButton({ datasetId, datasetName }: { datasetId: string; datasetName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    await fetch(`/api/datasets/${datasetId}`, { method: "DELETE" });
    window.location.href = "/";
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-600 dark:text-gray-400">Delete <strong>{datasetName}</strong>?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs px-3 py-1.5 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
        >
          {deleting ? "deleting…" : "yes, delete"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-red-300 dark:hover:border-red-700 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
    >
      delete
    </button>
  );
}

// Scan files for `source: NAME is` declarations to build a source→file map.
function buildSourceFileMap(files: Array<{ path: string; content: string }>): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^\s*source\s*:\s*(\w+)\s+is\b/gm;
  for (const { path, content } of files) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      map.set(m[1], path);
    }
  }
  return map;
}

type GitHubModel = NonNullable<DatasetDetail["malloyModel"]> & { files: NonNullable<DatasetDetail["malloyModel"]>["files"] };

function GitHubModelView({ datasetId, model }: { datasetId: string; model: GitHubModel }) {
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["index.malloy"]));

  const files = model.files!;
  const sourceFileMap = buildSourceFileMap(files);

  async function compile() {
    setCompiling(true);
    setCompileResult(null);
    try {
      const r = await fetch(`/api/datasets/${datasetId}/model/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setCompileResult(await r.json());
    } finally {
      setCompiling(false);
    }
  }

  function toggleFile(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold flex items-baseline gap-2 flex-wrap">
          malloy model{" "}
          {model.git ? (
            <CommitChip git={model.git} />
          ) : (
            <span className="text-gray-400 dark:text-gray-500 font-normal">(from {model.generatedBy})</span>
          )}
        </h2>
      </div>

      {model.sources && model.sources.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Sources</p>
          <div className="flex flex-wrap gap-2">
            {model.sources.map((s) => {
              const file = sourceFileMap.get(s);
              return (
                <div key={s} className="space-y-0.5">
                  <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-mono">
                    {s}
                  </span>
                  {file && (
                    <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono pl-0.5">{file}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Files ({files.length})
        </p>
        {files.map(({ path, content }) => (
          <div key={path} className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
            <button
              onClick={() => toggleFile(path)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-left hover:bg-gray-50 dark:hover:bg-gray-900/50"
            >
              <span className="text-gray-700 dark:text-gray-300">{path}</span>
              <span className="text-gray-400 dark:text-gray-500 text-[10px]">
                {expanded.has(path) ? "▲" : "▼"}
              </span>
            </button>
            {expanded.has(path) && (
              <pre className="text-[11px] bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-t border-gray-200 dark:border-gray-800 p-3 overflow-auto whitespace-pre">
                {content}
              </pre>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={compile}
          disabled={compiling}
          className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50"
        >
          {compiling ? "Compiling…" : "Compile"}
        </button>
      </div>

      {compileResult && (
        <div className="mt-1">
          {compileResult.ok ? (
            <div className="text-xs text-green-700 dark:text-green-400">✓ compiles</div>
          ) : (
            <pre className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 whitespace-pre-wrap">
              {compileResult.error}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

type MalloyModelSummary = DatasetDetail["malloyModel"];

function GitHubConfig({
  datasetId,
  initialRepo,
  initialBranch,
  onRefreshed,
}: {
  datasetId: string;
  initialRepo: string | null;
  initialBranch: string | null;
  onRefreshed: (model: MalloyModelSummary) => void;
}) {
  const [repo, setRepo] = useState(initialRepo ?? "");
  const [branch, setBranch] = useState(initialBranch ?? "main");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [showModal, setShowModal] = useState(false);

  const savedRepo = initialRepo ?? "";
  const savedBranch = initialBranch ?? "main";
  const dirty = repo !== savedRepo || branch !== savedBranch;

  async function saveConfig() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/datasets/${datasetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubRepo: repo || null, githubBranch: branch || null, githubUseToken: true }),
    });
    setSaving(false);
    if (!res.ok) { setError("save failed"); return; }
    setFlash("saved");
    setTimeout(() => setFlash(""), 1500);
  }

  async function refreshNow(): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/datasets/${datasetId}/model/github`, { method: "POST" });
    const j = await res.json();
    if (!res.ok || j.ok === false) return { ok: false, error: j.error ?? "refresh failed" };
    const dsRes = await fetch(`/api/datasets/${datasetId}`);
    if (dsRes.ok) onRefreshed((await dsRes.json()).malloyModel);
    return { ok: true };
  }

  return (
    <>
      <section className="border border-gray-200 dark:border-gray-800 rounded p-4 space-y-3">
        <h2 className="text-sm font-semibold">GitHub model</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Repo must have an <code>index.malloy</code> at its root. Imports are resolved from the same repo and branch.
        </p>
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Repository (owner/repo)</span>
            <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)}
              placeholder="lloydtabb/my-malloy-models"
              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          </label>
          <label className="w-28">
            <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Branch</span>
            <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          </label>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={saveConfig} disabled={saving || !repo}
              className="text-xs px-3 py-1 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          <button onClick={() => { setShowModal(true); setError(null); }} disabled={!initialRepo}
            className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50"
            title={!initialRepo ? "Save a repo first" : undefined}>
            Refresh from GitHub
          </button>
          {flash && <span className="text-xs text-green-700 dark:text-green-400">{flash}</span>}
        </div>
        {error && <pre className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</pre>}
      </section>

      {showModal && (
        <RefreshModal
          datasetId={datasetId}
          repo={initialRepo!}
          branch={initialBranch ?? "main"}
          onRefreshNow={refreshNow}
          onClose={(msg) => {
            setShowModal(false);
            if (msg) { setFlash(msg); setTimeout(() => setFlash(""), 4000); }
          }}
        />
      )}
    </>
  );
}

function RefreshModal({
  datasetId,
  repo,
  branch,
  onRefreshNow,
  onClose,
}: {
  datasetId: string;
  repo: string;
  branch: string;
  onRefreshNow: () => Promise<{ ok: boolean; error?: string }>;
  onClose: (flashMsg?: string) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  // window.location is browser-only; read it after mount so SSR and the first
  // client render agree (no hydration mismatch).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const webhookUrl = `${origin}/api/datasets/${datasetId}/webhook/github`;

  async function handleRefreshNow() {
    setRefreshing(true);
    setError(null);
    const result = await onRefreshNow();
    setRefreshing(false);
    if (!result.ok) { setError(result.error ?? "refresh failed"); return; }
    onClose("refreshed from GitHub");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4">
      <div className="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 space-y-5 font-mono text-sm">
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-semibold">Refresh from GitHub</h2>
          <button onClick={() => onClose()} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">×</button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Refresh now</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Pull the latest <code>index.malloy</code> from <strong>{repo}</strong> ({branch}) immediately.
          </p>
          <button onClick={handleRefreshNow} disabled={refreshing}
            className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50">
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
          {error && <pre className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-2 rounded">{error}</pre>}
        </div>

        <hr className="border-gray-200 dark:border-gray-800" />

        <div className="space-y-3">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Auto-refresh via GitHub webhook</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Add this webhook to your repo and the model will refresh automatically on every push to <strong>{branch}</strong>.
          </p>
          <WebhookUrlCopy url={webhookUrl} />
          <ol className="list-decimal list-inside space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <li>Go to{" "}<a href={`https://github.com/${repo}/settings/hooks`} target="_blank" rel="noopener noreferrer" className="underline text-blue-600 dark:text-blue-400">{repo} → Settings → Webhooks</a>{" "}→ Add webhook</li>
            <li>Paste the URL above as the Payload URL</li>
            <li>Content type: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">application/json</code></li>
            <li>Events: <em>Just the push event</em></li>
            <li>Click <strong>Add webhook</strong></li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function WebhookUrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded p-2 pr-16 overflow-auto whitespace-pre-wrap break-all">
        {url}
      </pre>
      <button
        onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute top-1.5 right-1.5 text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700">
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "ready"
      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
      : status === "failed"
        ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
        : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${color}`}>
      {status}
    </span>
  );
}
