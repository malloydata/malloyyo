// @ts-nocheck
// <VegaChart> — render a Vega-Lite spec against Malloy query results, entirely
// inside the sandboxed dashboard frame.
//
// The heavy engine (vega + vega-lite's compiler) is bundled ONCE into the
// frame runtime (dev: by the CLI bundler; hosted: into public/dashboard-vendor.js
// as window.__DASH_RUNTIME__). A Dashboard.tsx ships only a JSON spec + a Malloy
// query — the chart code is never loaded per dashboard. See
// scripts/build-dashboard-vendor.mjs and src/lib/dashboards/bundle.ts.
//
// SECURITY — the frame has no cookies and (once the CSP lands) no network. Two
// properties keep a chart spec from becoming an exfil / eval side-channel:
//   1. Data comes ONLY from Malloy. sanitizeSpec() strips every `url`/`loader`
//      (remote datasets, transform lookups, remote `image` marks) and forces the
//      dataset to inline `values`. A blocked vega loader rejects any load that
//      slips through, so a hand-written spec can't fetch a third-party origin.
//   2. Expressions run through vega's AST INTERPRETER (vega-interpreter), never
//      `new Function`, so the chart works under a strict `script-src` CSP.
import React, { useEffect, useMemo, useRef } from "react";
import { parse, View, loader } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile } from "vega-lite";
import { useQuery } from "./runtime";

// A loader that refuses every fetch — belt-and-suspenders with sanitizeSpec's
// url stripping. Nothing in a dashboard chart should ever hit the network.
const blockedLoader = (() => {
  const l = loader();
  const deny = () => Promise.reject(new Error("network access is disabled in dashboard charts"));
  l.load = deny;
  l.http = deny;
  l.file = deny;
  l.sanitize = () => Promise.reject(new Error("remote URLs are not allowed in dashboard charts"));
  return l;
})();

// Recursively delete anything that would pull bytes from outside the frame.
function stripRemote(node) {
  if (Array.isArray(node)) {
    node.forEach(stripRemote);
  } else if (node && typeof node === "object") {
    delete node.url; // remote datasets, transform lookups, remote `image` marks
    delete node.loader;
    for (const k of Object.keys(node)) stripRemote(node[k]);
  }
}

// Force the spec's data to our single inlined, named dataset ("table"), strip
// remote refs, and default to a container-width chart so it fills the panel.
function sanitizeSpec(spec, rows) {
  const s = JSON.parse(JSON.stringify(spec || {}));
  stripRemote(s);
  s.data = { name: "table", values: rows || [] };
  if (s.width == null) s.width = "container";
  s.autosize = s.autosize ?? { type: "fit", contains: "padding", resize: true };
  return s;
}

function renderError(container, err) {
  container.innerHTML = "";
  const pre = document.createElement("pre");
  pre.style.cssText = "color:crimson;white-space:pre-wrap;font:12px ui-monospace,monospace;margin:0";
  pre.textContent = "Vega chart error:\n" + ((err && (err.stack || err.message)) || String(err));
  container.appendChild(pre);
}

// Keep ONE vega View alive for a given spec and stream new rows into its "table"
// dataset in place (view.data + runAsync) — rebuilding the View per data change
// would blank/flash the chart on every control change, the same problem Panel
// solves for the Malloy renderer.
function VegaChartInner({ spec, rows, loading, style }) {
  const ref = useRef(null);
  const viewRef = useRef(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const specKey = useMemo(() => JSON.stringify(spec ?? null), [spec]);

  // (Re)build the View when the spec changes.
  useEffect(() => {
    if (!ref.current) return undefined;
    const container = ref.current;
    let cancelled = false;
    let view;
    (async () => {
      try {
        const vgSpec = compile(sanitizeSpec(spec, rowsRef.current)).spec;
        // ast:true + the interpreter = no `new Function`, so charts survive a
        // strict CSP. renderer 'svg' keeps it dependency-light (no canvas).
        view = new View(parse(vgSpec, {}, { ast: true }), {
          expr: expressionInterpreter,
          renderer: "svg",
          container,
          loader: blockedLoader,
          hover: true,
        });
        await view.runAsync();
        if (cancelled) {
          view.finalize();
          return;
        }
        viewRef.current = view;
      } catch (err) {
        if (!cancelled) renderError(container, err);
      }
    })();
    return () => {
      cancelled = true;
      try {
        if (view) view.finalize();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
  }, [specKey]);

  // Stream new rows into the live View — no rebuild, no flash.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    try {
      view.data("table", rows || []);
      view.runAsync();
    } catch (err) {
      if (ref.current) renderError(ref.current, err);
    }
  }, [rows]);

  return (
    <div
      ref={ref}
      style={{
        width: "100%",
        opacity: loading ? 0.4 : 1,
        transition: "opacity .15s",
        ...style,
      }}
    />
  );
}

/**
 * Render a Vega-Lite spec against Malloy data.
 *
 *   <VegaChart spec={spec} query="by_year" />          // run a named query
 *   <VegaChart spec={spec} malloy="run: flights -> …" givens={givens} />
 *   <VegaChart spec={spec} data={rows} />              // already have rows
 *
 * The spec's own `data` is ignored/overridden — rows are inlined as the named
 * dataset "table", so any Vega-Lite example works once you point its encodings
 * at your query's column names. Remote data URLs in the spec are stripped.
 */
export function VegaChart({ spec, data, query, malloy, givens, style }) {
  if (data != null) return <VegaChartInner spec={spec} rows={data} style={style} />;
  return <VegaChartQuery spec={spec} query={query} malloy={malloy} givens={givens} style={style} />;
}

function VegaChartQuery({ spec, query, malloy, givens, style }) {
  const req = malloy ? { malloy, givens } : { query, givens };
  const { rows, loading, error } = useQuery(req);
  if (error) return <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre>;
  return <VegaChartInner spec={spec} rows={rows} loading={loading} style={style} />;
}
