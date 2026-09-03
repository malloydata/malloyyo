// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
// The dashboard frame runtime and this view are the two places that render Malloy
// results and honor `# drill`, so they share one reading of the tag. Imported from
// source (the same tree scripts/build-dashboard-vendor.mjs bundles for the frame)
// — drill.ts is browser-only and host-agnostic by design.
import {
  drillFieldNames,
  humanizeSlug,
  markDrillableCells,
  resolveDrill,
  type CellClickPayload,
} from "../../packages/cli/src/frame-runtime/drill";

interface Props {
  stableResult: Record<string, unknown>;
  /** Where this is being rendered.
   *
   *  "page"       — the result owns the view (ltool). Reserves height and scrolls
   *                 itself, which is right when there is nothing else to read.
   *  "transcript" — one result among many in a scrolling conversation. Claims no
   *                 minimum height (an 8-row table must not reserve 350px),
   *                 caps its maximum so a long result cannot own the page, and
   *                 lets the transcript be the scroller. */
  variant?: "page" | "transcript";
  /** The dataset the query ran against — drill targets are dashboards inside it.
      Without it a drill has nowhere to go, so the affordance stays off. */
  /** The dataset to drill into, as its NAME. `/datasets/<ref>` resolves an id
      too, but an id in the address bar is not something to show anyone — the
      caller resolves the name before handing it over. */
  datasetRef?: string | null;
}

type MenuItem = { label: string; run: () => void };
type Menu = { x: number; y: number; items: MenuItem[] };

export function MalloyResultView({ stableResult, datasetRef, variant = "page" }: Props) {
  const inTranscript = variant === "transcript";
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [menu, setMenu] = useState<Menu | null>(null);

  const onCellClick = useCallback(
    (payload: CellClickPayload) => {
      if (!datasetRef) return;
      const drill = resolveDrill(payload);
      if (!drill) return;
      // `self` means "filter the dashboard you're already on". Ltool has no givens
      // of its own, so only real dashboard targets are offered here.
      const dests = drill.dests.filter((d) => d !== "self");
      if (!dests.length) return;
      const go = (dest: string) => {
        const u = new URL(`/datasets/${encodeURIComponent(datasetRef)}/dashboard/${encodeURIComponent(dest)}`, window.location.origin);
        // Givens are `$`-prefixed in dashboard URLs (see the dashboard page).
        u.searchParams.set(`$${drill.given}`, drill.filterExpr);
        router.push(u.pathname + u.search);
      };
      if (dests.length === 1) return go(dests[0]);
      const ev = payload.event ?? {};
      setMenu({
        x: ev.clientX ?? 0,
        y: ev.clientY ?? 0,
        items: dests.map((d) => ({ label: humanizeSlug(d), run: () => go(d) })),
      });
    },
    [datasetRef, router],
  );

  useEffect(() => {
    if (!containerRef.current || !stableResult) return;
    const container = containerRef.current;
    let cancelled = false;
    let vizCleanup: (() => void) | null = null;
    let observer: MutationObserver | null = null;

    import("@malloydata/render").then(({ MalloyRenderer }) => {
      if (cancelled || !container) return;
      const renderer = new MalloyRenderer({});
      const viz = renderer.createViz({
        // In a transcript the PAGE is the scroller, so the renderer must not
        // also virtualize against its own container — two virtualizers over one
        // scroll position fight, and the symptom is the view jumping as you
        // read (the dashboard frame runtime hit this and documents it).
        tableConfig: inTranscript
          ? { enableDrill: false, disableVirtualization: true, rowLimit: 1000 }
          : { enableDrill: false },
        ...(inTranscript
          ? { dashboardConfig: { disableVirtualization: true } }
          : { scrollEl: container }),
        // Clicking a `# drill`-tagged dimension opens the dashboard it points at
        // (no-op for every other cell).
        onClick: onCellClick,
      });
      try {
        viz.setResult(stableResult as Parameters<typeof viz.setResult>[0]);
        viz.render(container);
      } catch (e) {
        // One unrenderable result must not blank the conversation around it.
        container.textContent = `Could not render this result: ${e instanceof Error ? e.message : String(e)}`;
        vizCleanup = () => viz.remove();
        return;
      }
      // Flag drillable cells so they read as links (see .dash-drill in globals.css).
      // Only when a drill could actually navigate — a dead link is worse than none.
      const names = datasetRef ? drillFieldNames(viz) : new Set<string>();
      markDrillableCells(container, names);
      // A `# dashboard` result renders its cards progressively, so a one-shot mark
      // right after render() misses tables that appear a frame later.
      if (names.size && typeof MutationObserver !== "undefined") {
        let raf = 0;
        observer = new MutationObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => markDrillableCells(container, names));
        });
        observer.observe(container, { childList: true, subtree: true });
      }
      vizCleanup = () => viz.remove();
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      vizCleanup?.();
    };
  }, [stableResult, datasetRef, onCellClick, inTranscript]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          display: "grid",
          width: "100%",
          overflow: "auto",
          // A page-owned result reserves room; one in a transcript takes only
          // what it needs, up to a ceiling.
          ...(inTranscript ? { maxHeight: "60vh" } : { minHeight: "350px" }),
          // The renderer's sticky header is z-index 200 and escapes into the
          // root stacking context without its own, painting over the composer.
          isolation: "isolate",
          // It ships no dark theme, so a bare bubble in dark mode is unreadable.
          background: "#fff",
          color: "#171717",
          borderRadius: inTranscript ? 6 : undefined,
        }}
      />
      {menu && <DrillMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// Shown at the cursor when a drilled dimension names more than one dashboard.
// Fixed-position above everything; a full-viewport backdrop dismisses it.
function DrillMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 min-w-[180px] rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1"
        style={{ left: Math.min(menu.x, window.innerWidth - 220), top: menu.y }}
      >
        {menu.items.map((it) => (
          <button
            key={it.label}
            onClick={() => {
              it.run();
              onClose();
            }}
            className="block w-full text-left px-2.5 py-1.5 text-xs text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/60"
          >
            {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
