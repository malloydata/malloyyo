// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { Suspense, use, useEffect, useRef } from "react";
import { DatasetNav } from "@/components/DatasetNav";

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
  // use(params) suspends until the route params resolve — needs a Suspense boundary.
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

  useEffect(() => {
    // Set the iframe src ONCE, imperatively, from the actual URL (so a shared
    // link's `?$NAME=…` givens survive). NOT a reactive `src` prop derived from
    // useSearchParams(): that value settles once during the initial client
    // render, and rewriting a live <iframe src> reloads the frame — remounting
    // the whole dashboard (the "double paint" seen only on the hosted app; the
    // CLI dev server bakes a static src and never reloads). After load the frame
    // owns its givens and syncs the URL via replaceState (below), which must NOT
    // reload the iframe.
    const frame = iframeRef.current;
    if (frame && !frame.src) {
      frame.src = `/api/dashboards/${id}/${encodeURIComponent(name)}/frame${window.location.search}`;
    }
    async function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data;
      // Mirror the dashboard's givens into the URL (shareable) — replaceState so
      // filter tweaks don't spam history.
      if (m?.type === "givens") {
        const u = new URL(window.location.href);
        u.search = "";
        // Givens are `$`-prefixed in the URL; bare params are reserved for future
        // dimension filters. Skip empty (no-filter) givens so the URL stays clean.
        for (const [k, v] of Object.entries(m.givens as Record<string, unknown>)) {
          if (v != null && String(v) !== "") u.searchParams.set(`$${k}`, String(v));
        }
        window.history.replaceState(null, "", u.pathname + u.search);
        return;
      }
      // Drill (a `# drill { to }` dimension click the frame forwarded): open the
      // sibling dashboard in THIS dataset with the clicked dimension seeded.
      // Same-tab navigation (a postMessage-driven window.open would trip popup
      // blockers, and drill-down reads naturally with the back button).
      if (m?.type === "navigate" && typeof m.dashboard === "string") {
        const u = new URL(`/datasets/${id}/dashboard/${encodeURIComponent(m.dashboard)}`, window.location.origin);
        for (const [k, v] of Object.entries((m.givens ?? {}) as Record<string, unknown>)) {
          if (v != null && String(v) !== "") u.searchParams.set(`$${k}`, String(v));
        }
        window.location.href = u.pathname + u.search;
        return;
      }
      if (!m || m.type !== "run") return;
      let out: unknown;
      try {
        const res = await fetch("/api/dashboards/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: id, name, query: m.query, malloy: m.malloy, dashboard: m.dashboard, givens: m.givens }),
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
      <DatasetNav datasetId={id} activeDashboard={name} />
      <iframe
        ref={iframeRef}
        // allow-popups lets a link mark (# link) open its target on click;
        // allow-popups-to-escape-sandbox makes that popup a normal top-level
        // window (a plain external tab) instead of inheriting this frame's
        // opaque-origin sandbox. Without these, deep links are silently blocked
        // ("...sandboxed frame whose 'allow-popups' permission is not set").
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        // No `src` prop — set once imperatively in the effect above (see why).
        className="w-full rounded border border-gray-200 dark:border-gray-800"
        style={{ height: "calc(100vh - 96px)" }}
      />
    </main>
  );
}
