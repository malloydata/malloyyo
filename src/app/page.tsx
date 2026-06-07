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

type Me = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  slug: string | null;
  isAdmin: boolean;
};

export default function HomePage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [instanceName, setInstanceName] = useState("malloyyo");
  const [sources, setSources] = useState<SourceSummary[] | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    const meRes = await fetch("/api/me");
    const meJson = await meRes.json();
    setMe(meJson.user);
    if (meJson.instanceName) setInstanceName(meJson.instanceName);
    if (meJson.user) {
      const r = await fetch("/api/sources");
      if (r.ok) setSources(await r.json());
    }
  }

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

          <McpSetup instanceName={instanceName} />

          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {me.isAdmin ? "All sources" : "Public sources"}
              </h2>
              <button onClick={load} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">refresh</button>
            </div>
            {sources === null ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">loading…</p>
            ) : sources.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs">No sources yet.</p>
            ) : (
              <ul className="border border-gray-200 dark:border-gray-800 rounded divide-y divide-gray-200 dark:divide-gray-800">
                {sources.map((s, i) => (
                  <li key={`${s.datasetId}-${s.source}-${i}`}>
                    <Link href={`/datasets/${s.datasetId}`}
                      className="block px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium truncate block">{s.source}</span>
                          {s.description && (
                            <span className="text-gray-500 dark:text-gray-400 text-xs mt-0.5 block leading-relaxed">{s.description}</span>
                          )}
                          {!s.description && s.source !== s.model && (
                            <span className="text-gray-400 dark:text-gray-500 text-xs mt-0.5 block">in {s.model}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                          {me.isAdmin && (s.ownerEmail || s.ownerName) && (
                            <span className="text-gray-400 dark:text-gray-500 text-xs">
                              {s.ownerEmail ?? s.ownerName}
                            </span>
                          )}
                          {!s.isPublic && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              private
                            </span>
                          )}
                          {s.status !== "ready" && <StatusBadge status={s.status} />}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
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
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const mcpUrl = `${origin || "https://malloyyo.vercel.app"}/mcp`;

  return (
    <section className="border border-gray-200 dark:border-gray-800 rounded p-4 space-y-4">
      <h2 className="text-sm font-semibold">Connect to Claude</h2>

      <div className="space-y-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">Your MCP server URL</p>
        <Copyable value={mcpUrl} />
      </div>

      <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
        <p className="font-medium">claude.ai (web)</p>
        <ol className="list-decimal list-inside space-y-1 text-gray-600 dark:text-gray-400">
          <li>Go to <strong>claude.ai</strong> → Settings → Integrations</li>
          <li>Click <strong>Add MCP server</strong> and paste the URL above</li>
          <li>Name the connection <strong>{instanceName}</strong> — matching the name keeps tools easy to tell apart if you connect several instances</li>
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
        <Copyable value={`claude mcp add malloyyo --transport http ${mcpUrl}`} />
        <p className="text-gray-500 dark:text-gray-400">Run the command above, then follow the browser OAuth flow.</p>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400">
        Available tools: <code>list_sources</code>, <code>describe_source</code>,{" "}
        <code>compile_query</code>, <code>run_query</code>, <code>describe_query</code>
      </div>
    </section>
  );
}

function SignInOut({ me }: { me: Me | null }) {
  if (!me) {
    return (
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
