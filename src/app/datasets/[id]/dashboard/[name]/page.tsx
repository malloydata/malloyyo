// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";

// Trusted shell for a dashboard. Renders breadcrumbs + a sandboxed iframe, and
// brokers the iframe's run requests to /api/dashboards/run (viewer-scoped). The
// iframe is same-origin for now (dev); isolation via a separate artifact origin
// is the production hardening (docs/repo-artifacts.md §8).
export default function DashboardViewPage({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = use(params);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [datasetName, setDatasetName] = useState<string>("");

  useEffect(() => {
    fetch(`/api/datasets/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) setDatasetName(d.name);
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || m.type !== "run") return;
      let out: unknown;
      try {
        const res = await fetch("/api/dashboards/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: id, name, givens: m.givens }),
        });
        out = await res.json();
      } catch (err) {
        out = { ok: false, error: String(err) };
      }
      frame.contentWindow?.postMessage({ type: "result", id: m.id, ...(out as object) }, "*");
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id, name]);

  return (
    <main className="w-full px-6 py-5">
      <nav className="mb-3 flex items-center gap-2 font-mono text-xs text-gray-500 dark:text-gray-400">
        <Link href="/" className="hover:underline">home</Link>
        <span>/</span>
        <Link href={`/datasets/${id}`} className="hover:underline">{datasetName || "dataset"}</Link>
        <span>/</span>
        <span className="text-gray-700 dark:text-gray-300">{name}</span>
      </nav>
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-same-origin"
        src={`/api/dashboards/${id}/${encodeURIComponent(name)}/frame`}
        className="w-full rounded border border-gray-200 dark:border-gray-800"
        style={{ height: "calc(100vh - 96px)" }}
      />
    </main>
  );
}
