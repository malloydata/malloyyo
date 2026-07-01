// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type SourceSummary = {
  source: string;
  description: string | null;
  model: string;
  datasetId: string;
  status: string;
  isPublic: boolean;
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
  ownerEmail?: string | null;
  ownerName?: string | null;
  sources: SourceSummary[];
};

function groupByDataset(list: SourceSummary[]): DatasetGroup[] {
  const map = new Map<string, DatasetGroup>();
  for (const s of list) {
    let g = map.get(s.datasetId);
    if (!g) {
      g = { datasetId: s.datasetId, name: s.model, isPublic: s.isPublic, status: s.status, ownerEmail: s.ownerEmail, ownerName: s.ownerName, sources: [] };
      map.set(s.datasetId, g);
    }
    g.sources.push(s);
  }
  return [...map.values()];
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
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [favQueries, setFavQueries] = useState<FavQuery[]>([]);
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
    if (typeof meJson.claudeConnected === "boolean") setClaudeConnected(meJson.claudeConnected);
    if (meJson.user) {
      const [srcRes, favRes] = await Promise.all([fetch("/api/sources"), fetch("/api/favorited-queries")]);
      if (srcRes.ok) setSources(await srcRes.json());
      if (favRes.ok) setFavQueries(await favRes.json());
    }
  }

  // Favorited saved queries keyed by dataset+source, so we can list them under
  // each source. Capped when rendered.
  const favBySource = new Map<string, FavQuery[]>();
  for (const q of favQueries) {
    const key = `${q.datasetId}::${q.source}`;
    (favBySource.get(key) ?? favBySource.set(key, []).get(key)!).push(q);
  }

  // A claude.ai chat seeded to explore a source via this instance's MCP tools.
  const claudeExploreUrl = (source: string) =>
    `https://claude.ai/new?q=${encodeURIComponent(
      `Using the ${instanceName} Malloy tools, describe_source "${source}" on ${instanceName}, then help me explore it.`,
    )}`;

  if (me === undefined) return <main className="p-8 font-mono text-sm">loading…</main>;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold mb-2">{instanceName}</h1>
          <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
            A simple MCP server for Malloy semantic models. All you need is a
            database connection (or S3 bucket) and a GitHub repository for the
            semantic model. Use the MCP endpoint to ask analytical questions.
          </p>
        </div>
        <SignInOut me={me} />
      </header>

      {!me ? (
        <section className="border border-gray-200 dark:border-gray-800 rounded p-6 text-center space-y-3">
          <p className="text-gray-700 dark:text-gray-300">Sign in with Google to view datasets.</p>
          {/* NextAuth API endpoint, not a page route — a full-page nav is intended, so <Link> doesn't apply. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/api/auth/signin" className="inline-block rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2">
            Sign in with Google
          </a>
        </section>
      ) : (
        <>
          <section className="flex gap-3">
            {me.isAdmin && (
              <Link
                href="/datasets/new/github"
                className="inline-block rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-xs"
              >
                + Add Malloy model from GitHub
              </Link>
            )}
            <Link
              href="/ltool"
              className="inline-block rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              ltool
            </Link>
            {me.isAdmin && (
              <Link
                href="/admin/users"
                className="inline-block rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 ml-auto"
              >
                users
              </Link>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {me.isAdmin ? "All datasets" : "Public datasets"}
              </h2>
              <button onClick={load} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">refresh</button>
            </div>
            {sources === null ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">loading…</p>
            ) : sources.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">No sources yet.</p>
            ) : (
              <div className="space-y-4">
                {groupByDataset(sources).map((g) => (
                  <div key={g.datasetId} className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
                    {/* Dataset header */}
                    <Link href={`/datasets/${g.datasetId}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-900/70">
                      <span className="font-semibold truncate flex-1">{g.name}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {me.isAdmin && (g.ownerEmail || g.ownerName) && (
                          <span className="text-gray-400 dark:text-gray-500 text-xs truncate max-w-[160px]">
                            {g.ownerEmail ?? g.ownerName}
                          </span>
                        )}
                        <span className={`text-xs px-1.5 py-0.5 rounded ${g.isPublic ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
                          {g.isPublic ? "public" : "private"}
                        </span>
                        {g.status !== "ready" && <StatusBadge status={g.status} />}
                      </div>
                    </Link>
                    {/* Sources within the dataset */}
                    <ul className="divide-y divide-gray-100 dark:divide-gray-900">
                      {g.sources.map((s, i) => {
                        const favs = favBySource.get(`${s.datasetId}::${s.source}`) ?? [];
                        return (
                          <li key={`${s.datasetId}-${s.source}-${i}`} className="px-4 py-3">
                            <Link href={`/datasets/${s.datasetId}`} className="font-medium truncate block hover:underline">
                              {s.source}
                            </Link>
                            {s.description && (
                              <span className="text-gray-500 dark:text-gray-400 text-xs mt-0.5 block leading-relaxed">{s.description}</span>
                            )}

                            {/* Favorited saved queries for this source (top 10) */}
                            {favs.length > 0 && (
                              <ul className="mt-2 space-y-1">
                                {favs.slice(0, 10).map((q) => (
                                  <li key={q.slug ?? q.question}>
                                    <Link href={q.slug ? `/ltool/${q.slug}` : "#"}
                                      className="text-xs text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 flex items-start gap-1.5">
                                      <span className="text-amber-400 flex-shrink-0 leading-relaxed">★</span>
                                      <span className="flex-1 leading-relaxed">{q.question}</span>
                                      {q.favoriteCount > 1 && <span className="text-gray-400 dark:text-gray-500 flex-shrink-0 leading-relaxed">({q.favoriteCount})</span>}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            )}

                            {/* Explore with */}
                            <div className="flex items-center gap-2 mt-2 text-xs">
                              <span className="text-gray-400 dark:text-gray-500">Explore with:</span>
                              <button
                                onClick={() => {
                                  const url = claudeExploreUrl(s.source);
                                  if (claudeConnected) window.open(url, "_blank", "noopener,noreferrer");
                                  else { setClaudeTargetUrl(url); setShowClaudeSetup(true); }
                                }}
                                title={claudeConnected ? `Open a Claude chat on ${instanceName}` : `Connect ${instanceName} to Claude first`}
                                className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900">
                                Claude
                              </button>
                              <Link href={`/ltool?source=${encodeURIComponent(s.source)}&dataset=${s.datasetId}`}
                                className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900">
                                ltool
                              </Link>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
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
