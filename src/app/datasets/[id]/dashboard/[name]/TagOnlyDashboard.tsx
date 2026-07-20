// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useRef } from "react";

// In-page renderer for a TAG-ONLY dashboard (no Dashboard.tsx). There is no
// untrusted author code, so nothing needs sandboxing: the Malloy renderer's
// DefaultDashboard mounts DIRECTLY here in the trusted page, full-width, and the
// document itself scrolls — the VSCode/Composer experience, free of the iframe's
// lifecycle problems (double-paint, src freeze, the fixed-height box).
//
// It loads the same public vendor bundle the iframe uses (window.__DASH_RUNTIME__)
// and calls its mountInPage entry with a DIRECT-fetch host — the in-page twin of
// the postMessage broker in CustomDashboardFrame: run (→ /api/dashboards/run),
// navigate (→ sibling dashboard), and syncGivens (→ shareable URL).

const VENDOR_SRC = "/dashboard-vendor.js";

// Load the vendor bundle once; resolve when window.__DASH_RUNTIME__ is ready.
function loadVendor(): Promise<Record<string, unknown>> {
  const w = window as unknown as { __DASH_RUNTIME__?: Record<string, unknown> };
  if (w.__DASH_RUNTIME__) return Promise.resolve(w.__DASH_RUNTIME__);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${VENDOR_SRC}"]`);
    const onload = () => (w.__DASH_RUNTIME__ ? resolve(w.__DASH_RUNTIME__) : reject(new Error("dashboard vendor loaded but __DASH_RUNTIME__ is missing")));
    if (existing) {
      existing.addEventListener("load", onload, { once: true });
      existing.addEventListener("error", () => reject(new Error("failed to load dashboard vendor")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = VENDOR_SRC;
    s.onload = onload;
    s.onerror = () => reject(new Error("failed to load dashboard vendor"));
    document.head.appendChild(s);
  });
}

// `$`-prefixed given values from the current URL — the seed the runtime reads
// from window.__INITIAL_GIVENS__ (it strips the `$` itself).
function initialGivensFromUrl(): Record<string, string> {
  const g: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(window.location.search)) g[k] = v;
  return g;
}

// Reflect the committed givens into the URL (shareable) as `?$NAME=…`, skipping
// empties. Same contract CustomDashboardFrame applies to the iframe's messages.
function givensToUrl(givens: Record<string, unknown>): string {
  const u = new URL(window.location.href);
  u.search = "";
  for (const [k, v] of Object.entries(givens)) {
    if (v != null && String(v) !== "") u.searchParams.set(`$${k}`, String(v));
  }
  return u.pathname + u.search;
}

export function TagOnlyDashboard({
  id,
  name,
  info,
  givenSpecs,
}: {
  id: string;
  name: string;
  info: Record<string, unknown>;
  givenSpecs: unknown[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return; // one createRoot per mount (StrictMode-safe)
    const root = rootRef.current;
    if (!root) return;
    mountedRef.current = true;

    const w = window as unknown as Record<string, unknown>;
    // The runtime reads these globals (dashboardInfo()/givenSpecs()/seed).
    w.__DASHBOARD__ = info;
    w.__GIVENS__ = givenSpecs;
    w.__INITIAL_GIVENS__ = initialGivensFromUrl();

    let cancelled = false;
    loadVendor()
      .then((rt) => {
        if (cancelled) return;
        (rt.mountInPage as (o: unknown) => void)({
          root,
          // Governed query — the same viewer-scoped endpoint the iframe broker
          // calls. Returns the raw result the runtime normalizes.
          run: (req: { query?: string; malloy?: string }, givens: Record<string, unknown>) =>
            fetch("/api/dashboards/run", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ datasetId: id, name, query: req.query, malloy: req.malloy, givens }),
            })
              .then((res) => res.json())
              .catch((err) => ({ ok: false, error: String(err) })),
          // Drill to a sibling dashboard in this dataset, seeding the given.
          navigate: (dashboard: string, givens: Record<string, unknown>) => {
            const u = new URL(`/datasets/${id}/dashboard/${encodeURIComponent(dashboard)}`, window.location.origin);
            for (const [k, v] of Object.entries(givens)) {
              if (v != null && String(v) !== "") u.searchParams.set(`$${k}`, String(v));
            }
            window.location.href = u.pathname + u.search;
          },
          // Mirror committed givens into the URL (replaceState — no history spam).
          syncGivens: (givens: Record<string, unknown>) => {
            window.history.replaceState(null, "", givensToUrl(givens));
          },
        });
      })
      .catch((err) => {
        if (!cancelled && root) root.textContent = `Dashboard failed to load: ${String(err)}`;
      });

    return () => {
      cancelled = true;
    };
  }, [id, name, info, givenSpecs]);

  // Empty container React never fills — the vendor's own React createRoot()s into
  // it. min-height keeps the page from collapsing before the first result paints.
  return <div ref={rootRef} style={{ width: "100%", minHeight: "calc(100vh - 96px)" }} />;
}
