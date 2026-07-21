// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";

type AuthProvider = { id: string; name: string };

type SourceSummary = {
  source: string;
  description: string | null;
  model: string;
  datasetId: string;
  status: string;
  isPublic: boolean;
  // "owner/repo" the model was published from, null when not from GitHub.
  githubRepo: string | null;
  ownerEmail?: string | null;
  ownerName?: string | null;
};

// The front page is organized BY DATASET: the flat /api/sources list is grouped
// under its dataset (model = dataset name), so each dataset is a section with
// its exported sources listed beneath.
type DatasetGroup = {
  datasetId: string;
  name: string;
  isPublic: boolean;
  status: string;
  githubRepo: string | null;
  ownerEmail?: string | null;
  ownerName?: string | null;
  sources: SourceSummary[];
};

function groupByDataset(list: SourceSummary[]): DatasetGroup[] {
  const map = new Map<string, DatasetGroup>();
  for (const s of list) {
    let g = map.get(s.datasetId);
    if (!g) {
      g = { datasetId: s.datasetId, name: s.model, isPublic: s.isPublic, status: s.status, githubRepo: s.githubRepo ?? null, ownerEmail: s.ownerEmail, ownerName: s.ownerName, sources: [] };
      map.set(s.datasetId, g);
    }
    g.sources.push(s);
  }
  return [...map.values()];
}

// Group a dataset's questions by their source, preserving the input's
// most-recently-used order (both the source order and the questions within
// each source). A null source buckets under "".
function groupBySource(list: FavQuery[]): { bySource: Map<string, FavQuery[]>; order: string[] } {
  const bySource = new Map<string, FavQuery[]>();
  const order: string[] = [];
  for (const q of list) {
    const key = q.source ?? "";
    let arr = bySource.get(key);
    if (!arr) { arr = []; bySource.set(key, arr); order.push(key); }
    arr.push(q);
  }
  return { bySource, order };
}

type Me = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  slug: string | null;
  isAdmin: boolean;
};

type FavQuery = {
  datasetId: string;
  source: string;
  slug: string | null;
  question: string;
  favoriteCount: number;
};

export default function HomePage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [instanceName, setInstanceName] = useState("malloyyo");
  const [tagline, setTagline] = useState("");
  const [signinNotice, setSigninNotice] = useState("");
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [favQueries, setFavQueries] = useState<FavQuery[]>([]);
  const [dashboards, setDashboards] = useState<Array<{ datasetId: string; name: string; title: string }>>([]);
  // Claude connect-instructions modal — shown when clicking a source's Claude
  // button before the connector is linked. claudeTargetUrl is the explore chat
  // to continue to after setup.
  const [showClaudeSetup, setShowClaudeSetup] = useState(false);
  const [claudeTargetUrl, setClaudeTargetUrl] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    const meRes = await fetch("/api/me");
    const meJson = await meRes.json();
    setMe(meJson.user);
    if (meJson.instanceName) setInstanceName(meJson.instanceName);
    if (typeof meJson.tagline === "string") setTagline(meJson.tagline);
    if (typeof meJson.signinNotice === "string") setSigninNotice(meJson.signinNotice);
    if (Array.isArray(meJson.providers)) setProviders(meJson.providers);
    if (typeof meJson.claudeConnected === "boolean") setClaudeConnected(meJson.claudeConnected);
    if (meJson.user) {
      const [srcRes, favRes, dashRes] = await Promise.all([
        fetch("/api/sources"),
        fetch("/api/favorited-queries"),
        fetch("/api/dashboards"),
      ]);
      if (srcRes.ok) setSources(await srcRes.json());
      if (favRes.ok) setFavQueries(await favRes.json());
      if (dashRes.ok) setDashboards(await dashRes.json());
    }
  }

  // Favorited saved queries grouped by DATASET (merged across the dataset's
  // sources), preserving the API's most-recently-used ordering. The dataset
  // display order follows the first (most recent) question seen for each.
  const favByDataset = new Map<string, FavQuery[]>();
  const datasetOrder: string[] = [];
  for (const q of favQueries) {
    let list = favByDataset.get(q.datasetId);
    if (!list) { list = []; favByDataset.set(q.datasetId, list); datasetOrder.push(q.datasetId); }
    list.push(q);
  }

  // Every source grouped by dataset, plus a lookup for dataset metadata.
  const datasetGroups = sources ? groupByDataset(sources) : [];
  const datasetById = new Map(datasetGroups.map((g) => [g.datasetId, g]));

  // Dashboards grouped by dataset, for the per-dataset row below.
  const dashByDataset = new Map<string, Array<{ name: string; title: string }>>();
  for (const d of dashboards) {
    let arr = dashByDataset.get(d.datasetId);
    if (!arr) { arr = []; dashByDataset.set(d.datasetId, arr); }
    arr.push({ name: d.name, title: d.title });
  }

  // Datasets to render: those with questions first (recency order), then any
  // remaining datasets (their sources still show, just with no questions).
  const orderedDatasetIds = [
    ...datasetOrder,
    ...datasetGroups.map((g) => g.datasetId).filter((id) => !favByDataset.has(id)),
  ];

  // claude.ai chats seeded via this instance's MCP tools — one per source, one
  // for a whole dataset.
  const claudeExploreUrl = (source: string) =>
    `https://claude.ai/new?q=${encodeURIComponent(
      `Using the ${instanceName} Malloy tools, describe_source "${source}" on ${instanceName}, then help me explore it.`,
    )}`;
  const claudeExploreDatasetUrl = (dataset: string) =>
    `https://claude.ai/new?q=${encodeURIComponent(
      `Using the ${instanceName} Malloy tools, explore the "${dataset}" dataset on ${instanceName} — list its sources and help me analyze it.`,
    )}`;

  // Open a seeded Claude chat, or the connect-setup modal if not yet linked.
  function openClaude(url: string) {
    if (claudeConnected) window.open(url, "_blank", "noopener,noreferrer");
    else { setClaudeTargetUrl(url); setShowClaudeSetup(true); }
  }
  const exploreWithClaude = (source: string) => openClaude(claudeExploreUrl(source));

  if (me === undefined) return <main className="p-8 font-mono text-sm">loading…</main>;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold mb-2">{instanceName}</h1>
          {tagline && (
            <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
              {tagline}
            </p>
          )}
        </div>
        <SignInOut me={me} />
      </header>

      {!me ? (
        <section className="border border-gray-200 dark:border-gray-800 rounded p-6 text-center space-y-3">
          <p className="text-gray-700 dark:text-gray-300">Sign in to view datasets.</p>
          {signinNotice && (
            <p className="text-gray-500 dark:text-gray-400 text-xs leading-relaxed">{signinNotice}</p>
          )}
          {/* One button per provider configured in the environment (from /api/me,
              which reads configuredAuthProviders()). If none are advertised, fall
              back to the built-in Auth.js sign-in page. */}
          {providers.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void signIn(p.id)}
                  className="inline-block w-full max-w-xs rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 hover:opacity-90"
                >
                  Sign in with {p.name}
                </button>
              ))}
            </div>
          ) : (
            /* NextAuth API endpoint, not a page route — a full-page nav is intended, so <Link> doesn't apply. */
            /* eslint-disable-next-line @next/next/no-html-link-for-pages */
            <a href="/api/auth/signin" className="inline-block rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2">
              Sign in
            </a>
          )}
        </section>
      ) : (
        <>
          {me.isAdmin && (
            <section className="flex gap-3">
              <Link
                href="/admin"
                className="inline-block rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 ml-auto"
              >
                admin
              </Link>
            </section>
          )}

          {/* Datasets → sources → questions. Within each dataset, questions are
              grouped under their source (most recently used first). Each source
              name opens a menu to explore it with Claude or ltool. Sources with
              no questions are listed at the bottom of the dataset. */}
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Datasets</h2>
              <button onClick={load} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">refresh</button>
            </div>
            {sources === null ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">loading…</p>
            ) : orderedDatasetIds.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">No sources yet.</p>
            ) : (
              <div className="space-y-4">
                {orderedDatasetIds.map((dsId) => {
                  const g = datasetById.get(dsId);
                  const { bySource, order } = groupBySource(favByDataset.get(dsId) ?? []);
                  const withQuestions = new Set(order.filter((k) => k !== ""));
                  const additional = (g?.sources ?? []).filter((s) => !withQuestions.has(s.source));
                  return (
                    <div key={dsId} className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
                      <div className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-800">
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="font-semibold truncate">{g?.name ?? "dataset"}</span>
                          {g?.githubRepo && <GitHubLink repo={g.githubRepo} />}
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {g && g.status !== "ready" && <StatusBadge status={g.status} />}
                          {g && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${g.isPublic ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
                              {g.isPublic ? "public" : "private"}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => openClaude(claudeExploreDatasetUrl(g?.name ?? "dataset"))}
                            title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
                            className="text-[11px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 hover:bg-gray-100 dark:hover:bg-gray-900"
                          >
                            Explore in Claude
                          </button>
                          <Link
                            href={`/datasets/${encodeURIComponent(g?.name ?? dsId)}`}
                            title="Configure dataset"
                            aria-label="Configure dataset"
                            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <circle cx="12" cy="12" r="3" />
                              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                          </Link>
                        </div>
                      </div>

                      {(dashByDataset.get(dsId)?.length ?? 0) > 0 && (
                        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">dashboards</span>
                          {dashByDataset.get(dsId)!.map((d) => (
                            <Link
                              key={d.name}
                              href={`/datasets/${encodeURIComponent(g?.name ?? dsId)}/dashboard/${encodeURIComponent(d.name)}`}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
                            >
                              {d.title}
                            </Link>
                          ))}
                        </div>
                      )}

                      <div className="divide-y divide-gray-100 dark:divide-gray-900">
                        {order.map((srcKey) => {
                          const qs = bySource.get(srcKey) ?? [];
                          return (
                            <div key={srcKey || "(unspecified)"} className="px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-xs truncate">
                                  {srcKey || <span className="text-gray-500 dark:text-gray-400">{g?.name}</span>}
                                </span>
                                {srcKey && (
                                  <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                                    <span>explore with:</span>
                                    <button
                                      type="button"
                                      onClick={() => exploreWithClaude(srcKey)}
                                      title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
                                      className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
                                    >
                                      claude
                                    </button>
                                    <Link
                                      href={`/ltool?source=${encodeURIComponent(srcKey)}&dataset=${dsId}`}
                                      className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
                                    >
                                      ltool
                                    </Link>
                                  </div>
                                )}
                              </div>
                              <ul className="mt-1.5 space-y-1">
                                {qs.slice(0, 8).map((q) => (
                                  <li key={q.slug ?? q.question} className="flex items-start gap-2">
                                    <span className="text-gray-300 dark:text-gray-600 select-none leading-relaxed flex-shrink-0" aria-hidden>•</span>
                                    <Link href={q.slug ? `/ltool/${q.slug}` : "#"}
                                      className="flex-1 text-xs text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 leading-relaxed">
                                      {q.question}
                                    </Link>
                                  </li>
                                ))}
                                {qs.length > 8 && (
                                  <li className="flex items-start gap-2">
                                    <span className="flex-shrink-0 w-[1ch]" aria-hidden />
                                    <Link href={`/datasets/${encodeURIComponent(g?.name ?? dsId)}`} className="text-[11px] text-gray-400 dark:text-gray-500 hover:underline">
                                      +{qs.length - 8} more →
                                    </Link>
                                  </li>
                                )}
                              </ul>
                            </div>
                          );
                        })}

                        {additional.length > 0 && (
                          <div className="px-3 py-2">
                            {order.some((k) => k !== "") && (
                              <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">More sources</p>
                            )}
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {additional.map((s, i) => (
                                <SourceMenu key={`${s.source}-${i}`} source={s.source} datasetId={dsId} instanceName={instanceName}
                                  claudeConnected={claudeConnected} onClaude={exploreWithClaude} className="text-xs" />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* Connect-to-Claude instructions, shown when a Claude button is clicked
          before the connector is linked. Reuses the full McpSetup instructions. */}
      {showClaudeSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowClaudeSetup(false)}>
          <div className="bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold">Connect {instanceName} to Claude first</h2>
              <button onClick={() => setShowClaudeSetup(false)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 leading-none" title="Close">×</button>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              You haven&apos;t connected {instanceName} to Claude yet. One-time setup:
            </p>
            <McpSetup instanceName={instanceName} />
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => { if (claudeTargetUrl) window.open(claudeTargetUrl, "_blank", "noopener,noreferrer"); setShowClaudeSetup(false); }}
                className="text-xs px-3 py-1.5 rounded bg-black text-white dark:bg-white dark:text-black hover:opacity-80">
                Continue on to Claude.ai →
              </button>
              <button onClick={() => setShowClaudeSetup(false)}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// Octocat icon linking to the GitHub repo the dataset's model was published from.
function GitHubLink({ repo }: { repo: string }) {
  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`GitHub: ${repo}`}
      className="flex-shrink-0 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span className="sr-only">GitHub repository</span>
    </a>
  );
}

// A source name rendered as a link that opens a small menu to explore the
// source with Claude or ltool.
function SourceMenu({
  source,
  datasetId,
  instanceName,
  claudeConnected,
  onClaude,
  className,
}: {
  source: string;
  datasetId: string;
  instanceName: string;
  claudeConnected: boolean;
  onClaude: (source: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`text-blue-600 dark:text-blue-400 hover:underline ${className ?? ""}`}
      >
        {source}
      </button>
      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 min-w-[170px] rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => { setOpen(false); onClaude(source); }}
              title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
              className="block w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              Explore with Claude
            </button>
            <Link
              href={`/ltool?source=${encodeURIComponent(source)}&dataset=${datasetId}`}
              className="block w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-900 border-t border-gray-100 dark:border-gray-900"
            >
              Explore with ltool
            </Link>
          </div>
        </>
      )}
    </span>
  );
}

function Copyable({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className={`text-xs bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-2 overflow-auto ${multiline ? "whitespace-pre" : "whitespace-pre-wrap break-all"}`}>
        {value}
      </pre>
      <button
        onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute top-1.5 right-1.5 text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function McpSetup({ instanceName }: { instanceName: string }) {
  const [origin, setOrigin] = useState("");
  // window.location is browser-only; read it after mount so SSR and the first
  // client render agree (no hydration mismatch).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const mcpUrl = `${origin || "https://malloyyo.vercel.app"}/mcp`;

  return (
    <section className="border border-gray-200 dark:border-gray-800 rounded p-4 space-y-4">
      <h2 className="text-sm font-semibold">Connect to Claude</h2>

      <p className="text-xs text-gray-600 dark:text-gray-400">
        Use <strong>both</strong> values below. The server <strong>name</strong> matters as
        much as the URL — Claude prefixes every tool with it, so an exact match keeps tools
        clear when you connect several instances.
      </p>

      <div className="space-y-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">Server name</p>
        <Copyable value={instanceName} />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">Server URL</p>
        <Copyable value={mcpUrl} />
      </div>

      <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
        <p className="font-medium">claude.ai (web &amp; desktop app)</p>
        <ol className="list-decimal list-inside space-y-1 text-gray-600 dark:text-gray-400">
          <li>Go to <strong>Settings</strong> → <strong>Connectors</strong> → <strong>Customize</strong></li>
          <li>Click the <strong>+</strong> icon → <strong>Add custom connector</strong></li>
          <li>Set the name to <strong>{instanceName}</strong> (copy above) and paste the URL above</li>
          <li>claude.ai will open a Google sign-in → grant access on the consent page</li>
          <li>Done — {instanceName} tools appear in every new conversation</li>
        </ol>
      </div>

      <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
        <p className="font-medium">Anthropic Console (Workbench)</p>
        <ol className="list-decimal list-inside space-y-1 text-gray-600 dark:text-gray-400">
          <li>Go to <strong>console.anthropic.com</strong> → Workbench</li>
          <li>In the right panel, click <strong>MCP Servers → Add server</strong></li>
          <li>Paste the URL above and follow the OAuth sign-in flow</li>
        </ol>
      </div>

      <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
        <p className="font-medium">Claude Code (CLI)</p>
        <Copyable value={`claude mcp add ${instanceName.toLowerCase().replace(/\s+/g, "-")} --transport http ${mcpUrl}`} />
        <p className="text-gray-500 dark:text-gray-400">Run the command above, then follow the browser OAuth flow.</p>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400">
        Available tools: <code>list_sources</code>, <code>describe_source</code>,{" "}
        <code>query</code>, <code>open_share_link</code>
      </div>
    </section>
  );
}

function SignInOut({ me }: { me: Me | null }) {
  if (!me) {
    return (
      // NextAuth API endpoint, not a page route — full-page nav intended.
      // eslint-disable-next-line @next/next/no-html-link-for-pages
      <a href="/api/auth/signin"
        className="rounded bg-black text-white dark:bg-white dark:text-black text-xs px-3 py-1.5 whitespace-nowrap">
        Sign in
      </a>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      {me.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={me.image} alt="" className="size-6 rounded-full" width={24} height={24} />
      )}
      <div className="flex flex-col items-end">
        <span className="text-gray-700 dark:text-gray-300">{me.name ?? me.email}</span>
        {/* NextAuth API endpoint, not a page route — full-page nav intended. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/signout" className="text-gray-500 dark:text-gray-400 hover:underline">sign out</a>
      </div>
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
  return <span className={`inline-block px-2 py-0.5 rounded text-xs ${color}`}>{status}</span>;
}
