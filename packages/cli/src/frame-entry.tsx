// @ts-nocheck
// Browser entry for the SANDBOXED dashboard iframe. Bundled on demand by the
// dashboard dev server (esbuild, iife). This is the untrusted side: it holds no
// credentials and cannot reach the API directly (the frame is
// `sandbox="allow-scripts"`, so its origin is opaque and fetch is blocked). Its
// only channel is `postMessage` to the trusted parent shell, which runs the
// governed query and posts results back.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { MalloyRenderer } from "@malloydata/render";
// Aliased by the dev server to the dashboard's ./Dashboard.tsx.
import Dashboard from "virtual:dashboard";

const manifest = window.__MANIFEST__;

// --- bridge: ask the trusted parent to run a declared query with given values.
let seq = 0;
const pending = new Map();
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return; // only the trusted shell
  const m = e.data;
  if (m && m.type === "result" && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function runQuery(query, givens) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    parent.postMessage({ type: "run", id, query, givens }, "*");
  });
}

// A governed panel: runs a named query with the current givens and renders the
// result with Malloy's own renderer (same path the hosted app uses).
function Panel({ query, givens }) {
  const ref = useRef(null);
  const [state, setState] = useState({ loading: true });
  const q = query ?? manifest.query;
  const key = JSON.stringify(givens);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    runQuery(q, givens).then((m) => {
      if (cancelled) return;
      if (m.ok) setState({ loading: false, result: m.stable_result });
      else setState({ loading: false, error: JSON.stringify(m.problems, null, 2) });
    });
    return () => {
      cancelled = true;
    };
  }, [q, key]);
  useEffect(() => {
    if (!ref.current || !state.result) return;
    const container = ref.current;
    const renderer = new MalloyRenderer({});
    const viz = renderer.createViz({ tableConfig: { enableDrill: false }, scrollEl: container });
    viz.setResult(state.result);
    viz.render(container);
    return () => viz.remove();
  }, [state.result]);
  if (state.error) return <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{state.error}</pre>;
  return <div ref={ref} style={{ minHeight: 320, opacity: state.loading ? 0.4 : 1, transition: "opacity .15s" }} />;
}

function Root() {
  const [givens, setGivens] = useState(() => {
    const g = {};
    for (const spec of manifest.givens ?? []) g[spec.name] = spec.default;
    return g;
  });
  const setGiven = useCallback((name, value) => {
    setGivens((prev) => ({ ...prev, [name]: value }));
  }, []);
  return <Dashboard manifest={manifest} givens={givens} setGiven={setGiven} Panel={Panel} />;
}

createRoot(document.getElementById("root")).render(<Root />);
