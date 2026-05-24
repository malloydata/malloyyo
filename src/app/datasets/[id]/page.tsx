"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const MalloyCodeEditor = dynamic(
  () => import("@/components/MalloyCodeEditor").then((m) => m.MalloyCodeEditor),
  { ssr: false, loading: () => <div className="text-xs text-gray-500 dark:text-gray-400 p-3">loading editor…</div> },
);

type DatasetDetail = {
  id: string;
  name: string;
  sourceUrl: string;
  status: string;
  statusError: string | null;
  rowCount: number | null;
  createdAt: string;
  readyAt: string | null;
  workflowRunId: string | null;
  userSlug: string | null;
  isPublic: boolean;
  isAdmin: boolean;
  schema: Array<{ name: string; type: string; nullable: boolean }> | null;
  sampleRows: Record<string, unknown>[] | null;
  malloyModel: { source: string; generatedBy: string; compiledAt: string } | null;
};

const TERMINAL = new Set(["ready", "failed"]);

const STAGE_INFO: Record<string, { label: string; detail: string }> = {
  pending: {
    label: "Queued",
    detail:
      "Workflow is about to start — usually picks up within a couple seconds.",
  },
  ingesting: {
    label: "Streaming the file into blob storage",
    detail:
      "Pulling from the source URL straight into Cloudflare R2. A 50 MiB Parquet finishes in ~10–30s.",
  },
  introspecting: {
    label: "Reading the schema with DuckDB",
    detail:
      "Running DESCRIBE and pulling 50 sample rows directly from the Parquet on R2 — no full scan.",
  },
  modeling: {
    label: "Asking Claude to author a Malloy model",
    detail:
      "Claude Opus 4.7 sees the schema + samples and writes a Malloy semantic model. Up to 3 retries if it doesn't compile.",
  },
  ready: {
    label: "Ready",
    detail:
      "Your dataset is live and queryable through the MCP endpoint below.",
  },
  failed: {
    label: "Failed",
    detail: "See the error details below.",
  },
};

export default function DatasetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<DatasetDetail | null>(null);

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
          <p className="text-gray-500 dark:text-gray-400 break-all">{data.sourceUrl}</p>
        </div>
        {data.isAdmin && (
          <VisibilityToggle datasetId={data.id} initialIsPublic={data.isPublic} />
        )}
      </header>

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
        <span className="text-gray-500 dark:text-gray-400">rows</span>
        <span>{data.rowCount ? data.rowCount.toLocaleString() : "—"}</span>
        <span className="text-gray-500 dark:text-gray-400">workflow</span>
        <span className="break-all">{data.workflowRunId ?? "—"}</span>
        <span className="text-gray-500 dark:text-gray-400">created</span>
        <span>{new Date(data.createdAt).toLocaleString()}</span>
        <span className="text-gray-500 dark:text-gray-400">ready</span>
        <span>
          {data.readyAt ? new Date(data.readyAt).toLocaleString() : "—"}
        </span>
      </section>

      {data.statusError && (
        <section>
          <h2 className="text-sm font-semibold mb-1">error</h2>
          <pre className="text-red-700 dark:text-red-300 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-950/40 p-3 rounded">
            {data.statusError}
          </pre>
        </section>
      )}

      {data.status === "ready" && data.userSlug && (
        <McpPanel slug={data.userSlug} datasetName={data.name} />
      )}

      {data.schema && (
        <section>
          <h2 className="text-sm font-semibold mb-1">schema</h2>
          <div className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left px-3 py-1.5 font-normal">name</th>
                  <th className="text-left px-3 py-1.5 font-normal">type</th>
                  <th className="text-left px-3 py-1.5 font-normal">nullable</th>
                </tr>
              </thead>
              <tbody>
                {data.schema.map((c) => (
                  <tr
                    key={c.name}
                    className="border-t border-gray-200 dark:border-gray-800"
                  >
                    <td className="px-3 py-1">{c.name}</td>
                    <td className="px-3 py-1 text-gray-600 dark:text-gray-400">
                      {c.type}
                    </td>
                    <td className="px-3 py-1 text-gray-600 dark:text-gray-400">
                      {c.nullable ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.malloyModel && (
        <MalloyEditor
          datasetId={data.id}
          initialSource={data.malloyModel.source}
          generatedBy={data.malloyModel.generatedBy}
        />
      )}
    </main>
  );
}

type CompileResult = { ok: true; sql: string } | { ok: false; error: string };

function MalloyEditor({
  datasetId,
  initialSource,
  generatedBy,
}: {
  datasetId: string;
  initialSource: string;
  generatedBy: string;
}) {
  const [savedSource, setSavedSource] = useState(initialSource);
  const [savedBy, setSavedBy] = useState(generatedBy);
  const [source, setSource] = useState(initialSource);
  const [busy, setBusy] = useState<"compile" | "save" | null>(null);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty = source !== savedSource;

  async function compile() {
    setBusy("compile");
    setResult(null);
    try {
      const r = await fetch(`/api/datasets/${datasetId}/model/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      setResult(await r.json());
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      const r = await fetch(`/api/datasets/${datasetId}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setResult(j.ok === false ? j : { ok: false, error: j.error ?? "save failed" });
        return;
      }
      setResult({ ok: true, sql: j.sql });
      setSavedSource(j.model.source);
      setSavedBy(j.model.generatedBy);
      setSource(j.model.source);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold">
          malloy model{" "}
          <span className="text-gray-400 dark:text-gray-500 font-normal">
            (generated by {savedBy})
          </span>
        </h2>
        {dirty && (
          <span className="text-xs text-yellow-700 dark:text-yellow-400">unsaved</span>
        )}
      </div>

      <MalloyCodeEditor
        value={source}
        onChange={setSource}
        minHeight={`${Math.max(200, (source.split("\n").length + 2) * 20)}px`}
      />

      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={compile}
          disabled={busy !== null}
          className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50"
        >
          {busy === "compile" ? "Compiling…" : "Compile"}
        </button>
        <button
          onClick={save}
          disabled={busy !== null || !dirty}
          className="text-xs px-3 py-1 rounded bg-black text-white dark:bg-white dark:text-black disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save as new version"}
        </button>
        {dirty && (
          <button
            onClick={() => { setSource(savedSource); setResult(null); }}
            disabled={busy !== null}
            className="text-xs text-gray-500 dark:text-gray-400 hover:underline disabled:opacity-50"
          >
            reset
          </button>
        )}
        {savedFlash && (
          <span className="text-xs text-green-700 dark:text-green-400">saved ✓</span>
        )}
      </div>

      {result && (
        <div className="mt-3">
          {result.ok ? (
            <div>
              <div className="text-xs text-green-700 dark:text-green-400 mb-1">✓ compiles</div>
              <pre className="text-[11px] bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-800 rounded p-2 overflow-auto whitespace-pre">
                {result.sql}
              </pre>
            </div>
          ) : (
            <pre className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 whitespace-pre-wrap">
              {result.error}
            </pre>
          )}
        </div>
      )}
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

function McpPanel({ slug, datasetName }: { slug: string; datasetName: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const url = origin ? `${origin}/mcp/${slug}` : `/mcp/${slug}`;

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        malloyyo: { url },
      },
    },
    null,
    2,
  );

  const curlExample = `curl -s -X POST ${url} \\
  -H 'content-type: application/json' \\
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
      "name": "run_analytical_query",
      "arguments": {
        "dataset": "${datasetName}",
        "malloy": "run: ${datasetName} -> { aggregate: row_count is count() }"
      }
    }
  }'`;

  return (
    <section className="border border-green-300 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 rounded p-4 space-y-3">
      <h2 className="text-sm font-semibold">How to use this</h2>

      <div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          Your MCP endpoint
        </div>
        <Copyable value={url} />
      </div>

      <div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          Add to Claude Desktop ({" "}
          <code className="text-[10px]">
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>{" "}
          )
        </div>
        <Copyable value={claudeConfig} multiline />
      </div>

      <div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          Or test from a terminal
        </div>
        <Copyable value={curlExample} multiline />
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400">
        Tools available on this endpoint:{" "}
        <code>list_datasets</code>, <code>describe_semantic_model</code>,{" "}
        <code>sample_rows</code>, <code>compile_analytical_query</code>,{" "}
        <code>run_analytical_query</code>.
      </div>
    </section>
  );
}

function Copyable({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className={`text-xs bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-2 overflow-auto ${multiline ? "whitespace-pre" : "whitespace-pre-wrap break-all"}`}
      >
        {value}
      </pre>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="absolute top-1.5 right-1.5 text-[10px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
