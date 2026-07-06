// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

// Trusted shell for a dashboard. Renders breadcrumbs + a sandboxed iframe, and
// brokers the iframe's run requests to /api/dashboards/run (viewer-scoped).
// The iframe runs untrusted, repo-authored dashboard code, so it is sandboxed
// WITHOUT allow-same-origin: an opaque origin with no session, no app cookies,
// and no credentialed same-origin fetch — its only channel is postMessage. Its
// compiled bundle loads via a capability token the frame route embeds (no cookie
// needed); the vendor JS is public. A separate artifact origin is the remaining
// hardening (docs/repo-artifacts.md §8, docs/dashboard-iframe-security.md).
export default function DashboardViewPage(props: {
  params: Promise<{ id: string; name: string }>;
}) {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={null}>
      <DashboardView {...props} />
    </Suspense>
  );
}

function DashboardView({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = use(params);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [datasetName, setDatasetName] = useState<string>("");
  // The iframe src carries the URL's givens so a shared link opens filtered.
  // Computed from the initial query; givens changes update the URL via
  // replaceState (below), which doesn't re-trigger this, so the iframe stays put.
  const qs = useSearchParams().toString();
  const frameSrc = `/api/dashboards/${id}/${encodeURIComponent(name)}/frame${qs ? `?${qs}` : ""}`;

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
      // Mirror the dashboard's givens into the URL (shareable) — replaceState so
      // filter tweaks don't spam history.
      if (m?.type === "givens") {
        const u = new URL(window.location.href);
        u.search = "";
        for (const [k, v] of Object.entries(m.givens as Record<string, unknown>)) u.searchParams.set(k, String(v));
        window.history.replaceState(null, "", u.pathname + u.search);
        return;
      }
      if (!m || m.type !== "run") return;
      let out: unknown;
      try {
        const res = await fetch("/api/dashboards/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: id, name, query: m.query, malloy: m.malloy, givens: m.givens }),
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
        sandbox="allow-scripts"
        src={frameSrc}
        className="w-full rounded border border-gray-200 dark:border-gray-800"
        style={{ height: "calc(100vh - 96px)" }}
      />
    </main>
  );
}
